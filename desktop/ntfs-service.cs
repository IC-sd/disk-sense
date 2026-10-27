// The SCM service exposes only the metadata protocol from ntfs-indexer.cs.
// Executables and connection credentials live in an administrator-owned directory.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

partial class NtfsIndexer {
    const string ServiceProduct="io.github.ic-sd.disk-sense.ntfs/v1";
    static readonly SecurityIdentifier SystemSid=new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null);
    static readonly SecurityIdentifier AdminSid=new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid,null);
    static readonly SemaphoreSlim SnapshotGate=new SemaphoreSlim(1,1);
    [ThreadStatic] static bool PersistentConnection;
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenSCManagerW(string machine,string database,uint access);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenServiceW(IntPtr manager,string name,uint access);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateServiceW(IntPtr manager,string name,string display,uint access,uint type,uint start,uint error,string binary,string group,IntPtr tag,string dependencies,string account,string password);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ChangeServiceConfigW(IntPtr service,uint type,uint start,uint error,string binary,string group,IntPtr tag,string dependencies,string account,string password,string display);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool DeleteService(IntPtr service);
    [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr service);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool ChangeServiceConfig2W(IntPtr service,int level,ref ServiceActions actions);
    [StructLayout(LayoutKind.Sequential)] struct RestartAction { public int type;public uint delay; }
    [StructLayout(LayoutKind.Sequential)] struct ServiceActions { public uint reset;public IntPtr reboot,command;public uint count;public IntPtr actions; }

    static string ServiceSuffix(string sid) {
        new SecurityIdentifier(sid);
        using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(sid))).Replace("-","").ToLowerInvariant().Substring(0,16);
    }
    static string ServiceDirectory(string sid) {
        string programFiles=Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        return Path.Combine(programFiles,"Disk Sense Search",ServiceSuffix(sid));
    }
    static string ServiceNameFor(string sid){return "DiskSenseSearch-"+ServiceSuffix(sid);}
    static string ExecutableFor(string sid){return Path.Combine(ServiceDirectory(sid),"ntfs-service.exe");}
    static string ProfileFor(string sid){return Path.Combine(ServiceDirectory(sid),"connection.json");}
    static Dictionary<string,object> ReadServiceProfile(string sid) {
        var value=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(ProfileFor(sid),Encoding.UTF8));
        if((string)value["product"]!=ServiceProduct||(string)value["sid"]!=sid||(string)value["serviceName"]!=ServiceNameFor(sid)
            ||(string)value["executable"]!=ExecutableFor(sid)||(string)value["pipe"]!="DiskSenseNtfs-service-"+ServiceSuffix(sid)
            ||!Regex.IsMatch((string)value["token"],"^[a-f0-9]{64}$"))throw new InvalidDataException("Invalid installed search service profile");
        return value;
    }
    static void RequireAdministrator() {
        if(!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))throw new UnauthorizedAccessException("Administrator permission is required to configure the search service");
    }
    static void RejectReparse(string target) {
        if((Directory.Exists(target)||File.Exists(target))&&(File.GetAttributes(target)&FileAttributes.ReparsePoint)!=0)
            throw new IOException("A search service installation path is a reparse point");
    }
    static void ProtectDirectory(string directory) {
        RejectReparse(directory);
        var security=new DirectorySecurity();security.SetAccessRuleProtection(true,false);security.SetOwner(AdminSid);
        foreach(var sid in new SecurityIdentifier[]{SystemSid,AdminSid})security.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid,null),FileSystemRights.ReadAndExecute,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
        Directory.CreateDirectory(directory,security);Directory.SetAccessControl(directory,security);
    }
    static void WriteProtected(string target,string content,string sid) {
        RejectReparse(target);
        // Apply the private ACL before writing credentials, including on first install.
        if(!File.Exists(target))using(File.Create(target)){}
        var security=new FileSecurity();security.SetAccessRuleProtection(true,false);security.SetOwner(AdminSid);
        security.AddAccessRule(new FileSystemAccessRule(SystemSid,FileSystemRights.FullControl,AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(AdminSid,FileSystemRights.FullControl,AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.Read,AccessControlType.Allow));
        File.SetAccessControl(target,security);File.WriteAllText(target,content,new UTF8Encoding(false));
    }
    static bool ExistsService(string name) {
        using(var key=Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\"+name))return key!=null;
    }
    static void VerifyOwnedService(string sid) {
        using(var key=Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\"+ServiceNameFor(sid))) {
            if(key==null)return;
            string expected="\""+ExecutableFor(sid)+"\" --windows-service "+sid;
            if(!String.Equals((string)key.GetValue("ImagePath"),expected,StringComparison.OrdinalIgnoreCase))throw new IOException("The service name belongs to a different executable");
        }
    }
    static void StopSearchService(string name) {
        if(!ExistsService(name))return;
        using(var service=new ServiceController(name)) {
            if(service.Status!=ServiceControllerStatus.Stopped){service.Stop();service.WaitForStatus(ServiceControllerStatus.Stopped,TimeSpan.FromSeconds(30));}
        }
    }
    static void StartSearchService(string name) {
        using(var service=new ServiceController(name)) {
            if(service.Status!=ServiceControllerStatus.Running){service.Start();service.WaitForStatus(ServiceControllerStatus.Running,TimeSpan.FromSeconds(30));}
        }
    }
    static void ConfigureSearchService(string sid) {
        IntPtr manager=OpenSCManagerW(null,null,3);if(manager==IntPtr.Zero)throw new Win32Exception();
        try {
            string name=ServiceNameFor(sid),binary="\""+ExecutableFor(sid)+"\" --windows-service "+sid;
            IntPtr service=OpenServiceW(manager,name,0xf01ff);
            if(service==IntPtr.Zero)service=CreateServiceW(manager,name,"Disk Sense Read-only File Search",0xf01ff,0x10,2,1,binary,null,IntPtr.Zero,null,"LocalSystem",null);
            if(service==IntPtr.Zero)throw new Win32Exception();
            try {
                if(!ChangeServiceConfigW(service,0xffffffff,2,1,binary,null,IntPtr.Zero,null,"LocalSystem",null,"Disk Sense Read-only File Search"))throw new Win32Exception();
                var action=new RestartAction{type=1,delay=5000};IntPtr memory=Marshal.AllocHGlobal(Marshal.SizeOf(action));
                try {
                    Marshal.StructureToPtr(action,memory,false);var actions=new ServiceActions{reset=86400,count=1,actions=memory};
                    if(!ChangeServiceConfig2W(service,2,ref actions))throw new Win32Exception();
                }finally{Marshal.FreeHGlobal(memory);}
            }finally{CloseServiceHandle(service);}
        }finally{CloseServiceHandle(manager);}
    }
    static void InstallSearchService(string sid,string version) {
        RequireAdministrator();if(!Regex.IsMatch(version,"^[a-f0-9]{20}$"))throw new ArgumentException("Invalid service version");
        string directory=ServiceDirectory(sid),parent=Path.GetDirectoryName(directory),executable=ExecutableFor(sid),name=ServiceNameFor(sid);
        RejectReparse(Path.GetDirectoryName(parent));ProtectDirectory(parent);ProtectDirectory(directory);VerifyOwnedService(sid);
        Dictionary<string,object> previous=null;
        if(File.Exists(ProfileFor(sid)))previous=ReadServiceProfile(sid);
        string token;
        if(previous!=null)token=(string)previous["token"];
        else {var bytes=new byte[32];using(var random=RandomNumberGenerator.Create())random.GetBytes(bytes);token=BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant();}
        string stage=executable+".new",rollback=executable+".rollback";
        foreach(string target in new string[]{executable,stage,rollback})RejectReparse(target);
        File.Copy(System.Reflection.Assembly.GetExecutingAssembly().Location,stage,true);
        StopSearchService(name);
        bool hadBinary=File.Exists(executable),hadService=ExistsService(name);
        try {
            if(hadBinary)File.Copy(executable,rollback,true);
            File.Copy(stage,executable,true);
            var profile=new{product=ServiceProduct,sid=sid,pipe="DiskSenseNtfs-service-"+ServiceSuffix(sid),token=token,version=version,serviceName=name,executable=executable};
            WriteProtected(ProfileFor(sid),Json.Serialize(profile),sid);
            ConfigureSearchService(sid);StartSearchService(name);
            if(File.Exists(rollback))File.Delete(rollback);
        } catch {
            StopSearchService(name);
            if(hadBinary&&File.Exists(rollback))File.Copy(rollback,executable,true);
            if(previous!=null)WriteProtected(ProfileFor(sid),Json.Serialize(previous),sid);
            if(hadService&&hadBinary)StartSearchService(name);
            else if(!hadService)DeleteSearchService(sid);
            throw;
        } finally {if(File.Exists(stage))File.Delete(stage);}
    }
    static void DeleteSearchService(string sid) {
        IntPtr manager=OpenSCManagerW(null,null,1);if(manager==IntPtr.Zero)throw new Win32Exception();
        try {
            IntPtr service=OpenServiceW(manager,ServiceNameFor(sid),0x10000);
            if(service==IntPtr.Zero){if(Marshal.GetLastWin32Error()==1060)return;throw new Win32Exception();}
            try{if(!DeleteService(service))throw new Win32Exception();}finally{CloseServiceHandle(service);}
        }finally{CloseServiceHandle(manager);}
    }
    static void UninstallSearchService(string sid) {
        RequireAdministrator();VerifyOwnedService(sid);StopSearchService(ServiceNameFor(sid));DeleteSearchService(sid);
        // Fixed owned artifacts only. The search database and user files are retained.
        foreach(string file in new string[]{"connection.json","ntfs-service.exe","ntfs-service.exe.rollback","ntfs-service.exe.new"}) {
            string target=Path.Combine(ServiceDirectory(sid),file);RejectReparse(target);if(File.Exists(target))File.Delete(target);
        }
    }
    static int ServiceCommand(string[] args) {
        string mode=args[0];
        if(mode=="--windows-service") {
            if(args.Length!=2)throw new ArgumentException("Invalid Windows service arguments");
            ServiceBase.Run(new MetadataWindowsService(args[1]));return 0;
        }
        if(mode=="--service-plan"&&args.Length==2) {
            string sid=args[1];Send(new{serviceName=ServiceNameFor(sid),directory=ServiceDirectory(sid),account="LocalSystem",start="Automatic",operations=new string[]{"probe","snapshot","journal","identity"}});return 0;
        }
        if(mode=="--service-launch"&&args.Length==3) {
            string action=args[1],sid=args[2];ServiceSuffix(sid);
            if(sid!=WindowsIdentity.GetCurrent().User.Value)throw new UnauthorizedAccessException("Only the current user's search service can be configured");
            if(action!="install"&&action!="uninstall"&&action!="restart")throw new ArgumentException("Invalid service action");
            string self=System.Reflection.Assembly.GetExecutingAssembly().Location;
            var version=Regex.Match(Path.GetFileName(self),@"^ntfs-([a-f0-9]{20})\.exe$");
            if(!version.Success)throw new ArgumentException("Invalid compiled search helper name");
            try {
                using(var child=Process.Start(new ProcessStartInfo{FileName=self,Arguments="--service-"+action+" "+sid+" "+version.Groups[1].Value,UseShellExecute=true,Verb="runas",WindowStyle=ProcessWindowStyle.Hidden})) {
                    child.WaitForExit();
                    if(child.ExitCode!=0) {
                        string message="Windows could not configure the search service";
                        try{var result=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(ServiceDirectory(sid),"install-result.json")));message=(string)result["message"];}catch{}
                        Send(new{type="error",code="NTFS_SERVICE_INSTALL_FAILED",message=message});return 1;
                    }
                }
                Send(new{type="service-configured",action=action,serviceName=ServiceNameFor(sid)});return 0;
            }catch(Win32Exception error){Send(new{type="error",code=error.NativeErrorCode==1223?"NTFS_ELEVATION_CANCELLED":"NTFS_SERVICE_INSTALL_FAILED",message=error.Message});return 1;}
        }
        if(args.Length==3&&(mode=="--service-install"||mode=="--service-uninstall"||mode=="--service-restart")) {
            string sid=args[1];ServiceSuffix(sid);
            try {
                RequireAdministrator();
                if(mode=="--service-install")InstallSearchService(sid,args[2]);
                else if(mode=="--service-uninstall")UninstallSearchService(sid);
                else {VerifyOwnedService(sid);StopSearchService(ServiceNameFor(sid));StartSearchService(ServiceNameFor(sid));}
                WriteProtected(Path.Combine(ServiceDirectory(sid),"install-result.json"),Json.Serialize(new{success=true,message=""}),sid);return 0;
            } catch(Exception error) {
                try{WriteProtected(Path.Combine(ServiceDirectory(sid),"install-result.json"),Json.Serialize(new{success=false,message=error.Message}),sid);}catch{}
                return 1;
            }
        }
        throw new ArgumentException("Unsupported service command");
    }
    sealed class MetadataWindowsService : ServiceBase {
        readonly string Sid;readonly object Gate=new object();readonly List<NamedPipeServerStream> Pipes=new List<NamedPipeServerStream>();
        readonly SemaphoreSlim Slots=new SemaphoreSlim(4,4);Thread Listener;volatile bool Stopping;
        public MetadataWindowsService(string sid){Sid=sid;ServiceName=ServiceNameFor(sid);CanStop=true;CanShutdown=true;AutoLog=false;}
        protected override void OnStart(string[] args){Stopping=false;var profile=ReadServiceProfile(Sid);Listener=new Thread(()=>Listen(profile));Listener.IsBackground=true;Listener.Start();}
        protected override void OnStop(){Stopping=true;lock(Gate){foreach(var pipe in Pipes)try{pipe.Dispose();}catch{} }if(Listener!=null)Listener.Join(3000);}
        protected override void OnShutdown(){OnStop();}
        void Listen(Dictionary<string,object> profile) {
            var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid,null),PipeAccessRights.FullControl,AccessControlType.Deny));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(Sid),PipeAccessRights.ReadWrite,AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(SystemSid,PipeAccessRights.FullControl,AccessControlType.Allow));
            while(!Stopping) {
                if(!Slots.Wait(500))continue;
                NamedPipeServerStream pipe=null;
                try {
                    pipe=new NamedPipeServerStream((string)profile["pipe"],PipeDirection.InOut,4,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,security);
                    lock(Gate){if(Stopping){pipe.Dispose();Slots.Release();return;}Pipes.Add(pipe);}
                    pipe.WaitForConnection();var connected=pipe;
                    var thread=new Thread(()=>Handle(connected,profile));thread.IsBackground=true;thread.Start();
                }catch(Exception){if(pipe!=null){lock(Gate)Pipes.Remove(pipe);pipe.Dispose();}Slots.Release();if(!Stopping)Thread.Sleep(500);}
            }
        }
        void Handle(NamedPipeServerStream pipe,Dictionary<string,object> profile) {
            try {
                using(pipe)
                using(var input=new StreamReader(pipe,new UTF8Encoding(false),false,65536,true))
                using(var output=new StreamWriter(pipe,new UTF8Encoding(false),65536,true)) {
                    Output=output;PersistentConnection=true;
                    var hello=Json.Deserialize<Dictionary<string,object>>(input.ReadLine()??"{}");
                    if(!hello.ContainsKey("token")||(string)hello["token"]!=(string)profile["token"]){Send(new{type="error",code="NTFS_AUTH_FAILED",message="Broker authentication failed"});return;}
                    Send(new{type="hello",protocol=1,elevated=true,persistent=true,version=profile["version"]});NtfsIndexer.Run(input);
                }
            }catch(Exception){} // A malformed or disconnected client must not terminate the service.
            finally{Output=null;PersistentConnection=false;lock(Gate)Pipes.Remove(pipe);Slots.Release();}
        }
    }
}
