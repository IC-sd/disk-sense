// Read-only NTFS metadata operations using documented Windows APIs.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
using System.ComponentModel;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

partial class NtfsIndexer {
    const uint QueryJournal = 0x900f4, EnumUsn = 0x900b3, ReadJournal = 0x900bb, ReadUnprivileged = 0x903ab;
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool DeviceIoControl(SafeFileHandle handle,uint code,byte[] input,int inputLength,byte[] output,int outputLength,out int returned,IntPtr overlapped);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetVolumeInformationW(string root,StringBuilder name,int nameLength,out uint serial,out uint maximum,out uint flags,StringBuilder fs,int fsLength);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInformation information);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle handle,long offset,out long position,uint origin);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(SafeFileHandle handle,IntPtr buffer,int count,out int read,IntPtr overlapped);
    [DllImport("kernel32.dll",SetLastError=true)] static extern SafeFileHandle OpenFileById(SafeFileHandle volume,byte[] id,uint access,uint share,IntPtr security,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle file,StringBuilder name,uint length,uint flags);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstFileNameW(string file,uint flags,ref uint length,StringBuilder name);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool FindNextFileNameW(IntPtr find,ref uint length,StringBuilder name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool FindClose(IntPtr find);
    [StructLayout(LayoutKind.Sequential)] struct FileInformation {
        public uint attributes,createdLow,createdHigh,accessedLow,accessedHigh,modifiedLow,modifiedHigh;
        public uint serial,sizeHigh,sizeLow,links,indexHigh,indexLow;
    }
    [ThreadStatic] static JavaScriptSerializer ThreadJson;
    static JavaScriptSerializer Json { get { return ThreadJson??(ThreadJson=new JavaScriptSerializer { MaxJsonLength=16*1024*1024 }); } }
    [ThreadStatic] static TextWriter Output;
    static void Send(object value) { var output=Output??Console.Out;output.WriteLine(Json.Serialize(value));output.Flush(); }
    class NtfsException : Exception {
        public string Code; public NtfsException(string code,string message):base(message){Code=code;}
    }
    class Link { public ulong Parent;public string Name; }
    class Node {
        public ulong Id; public uint Attributes; public long Size,Modified;
        public bool Directory,IncompleteNames;
        public List<Link> Links=new List<Link>();
        public HashSet<ulong> Extensions=new HashSet<ulong>();
        public List<byte[]> AttributeLists=new List<byte[]>();
    }
    static long TimeMs(long fileTime){return fileTime>=116444736000000000L?(fileTime-116444736000000000L)/10000:0;}
    static uint U32(byte[] b,int p){return BitConverter.ToUInt32(b,p);}
    static ushort U16(byte[] b,int p){return BitConverter.ToUInt16(b,p);}
    static ulong U64(byte[] b,int p){return BitConverter.ToUInt64(b,p);}
    static long I64(byte[] b,int p){return BitConverter.ToInt64(b,p);}
    static SafeFileHandle OpenVolume(string root) {
        root=ValidateRoot(root);
        var fs=new DriveInfo(root);
        if(!fs.IsReady || fs.DriveFormat!="NTFS" || fs.DriveType!=DriveType.Fixed) throw new NtfsException("NTFS_UNSUPPORTED","A fixed NTFS drive is required");
        var handle=CreateFileW(@"\\.\"+root.Substring(0,2),0x80000000,7,IntPtr.Zero,3,0,IntPtr.Zero);
        if(handle.IsInvalid){int code=Marshal.GetLastWin32Error();handle.Dispose();throw new NtfsException(code==5?"NTFS_PERMISSION_REQUIRED":"NTFS_OPEN_FAILED","Cannot open read-only volume: "+code);}
        return handle;
    }
    static byte[] Journal(SafeFileHandle volume) {
        var bytes=new byte[80];int returned;
        if(!DeviceIoControl(volume,QueryJournal,null,0,bytes,bytes.Length,out returned,IntPtr.Zero)) throw new NtfsException("NTFS_JOURNAL_UNAVAILABLE","Cannot read journal: "+Marshal.GetLastWin32Error());
        if(returned<56)throw new NtfsException("NTFS_INVALID_BUFFER","Short journal metadata");
        return bytes;
    }
    static ulong RootId(string root) {
        using(var handle=CreateFileW(root,0x80,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero)) {
            FileInformation data;if(handle.IsInvalid||!GetFileInformationByHandle(handle,out data))throw new NtfsException("NTFS_ROOT_FAILED","Cannot identify root");
            return ((ulong)data.indexHigh<<32)|data.indexLow;
        }
    }
    static string Serial(string root) {
        uint serial,maximum,flags;var fs=new StringBuilder(64);var label=new StringBuilder(256);
        if(!GetVolumeInformationW(root,label,label.Capacity,out serial,out maximum,out flags,fs,fs.Capacity))throw new NtfsException("NTFS_VOLUME_CHANGED","Volume unavailable");
        return serial.ToString();
    }
    static void AttributeList(byte[] bytes,int offset,int length,Node node) {
        int end=checked(offset+length);
        while(offset+4<=end) {
            uint type=U32(bytes,offset);if(type==0||type==UInt32.MaxValue)break;
            if(offset+26>end)throw new NtfsException("NTFS_INVALID_RECORD","Short attribute list entry");
            int size=U16(bytes,offset+4);if(size<26||offset+size>end)throw new NtfsException("NTFS_INVALID_RECORD","Invalid attribute list entry");
            node.Extensions.Add(U64(bytes,offset+16));offset+=size;
        }
    }
    static bool ParseRecord(byte[] b,int start,int length,ulong ordinal,int sector,Dictionary<ulong,Node> nodes,bool driverFixed=false) {
        if(length<48||start<0||start+length>b.Length)throw new NtfsException("NTFS_INVALID_RECORD","Invalid MFT record bounds");
        if(U32(b,start)!=0x454c4946)return false;
        int usa=U16(b,start+4),count=U16(b,start+6);
        // NTFS fixup stride is 512, including on disks with larger physical sectors.
        if(usa<8||usa+count*2>510||count<2||(count-1)*512!=length)throw new NtfsException("NTFS_INVALID_RECORD","Invalid update sequence array");
        // FSCTL_GET_NTFS_FILE_RECORD returns the driver's in-memory record. Sector
        // trailers may have changed since its last disk write; never restore stale USA data.
        if(!driverFixed) {
            ushort sequence=U16(b,start+usa);
            for(int i=1;i<count;i++) {
                int tail=start+i*512-2;ushort replacement=U16(b,start+usa+i*2),actual=U16(b,tail);
                if(actual!=sequence)throw new NtfsException("NTFS_TORN_RECORD","Concurrent or torn MFT record");
                b[tail]=(byte)replacement;b[tail+1]=(byte)(replacement>>8);
            }
        }
        ushort flags=U16(b,start+22);if((flags&1)==0)return false;
        ulong ownId=ordinal|((ulong)U16(b,start+16)<<48),baseId=U64(b,start+32),id=baseId==0?ownId:baseId;
        Node node;if(!nodes.TryGetValue(id,out node)){node=new Node{Id=id};nodes.Add(id,node);}
        if(baseId==0){node.Directory=(flags&2)!=0;}
        int used=(int)U32(b,start+24),position=U16(b,start+20);
        if(used>length||used<48||position<48||position>used)throw new NtfsException("NTFS_INVALID_RECORD","Invalid attribute bounds");
        while(position+8<=used) {
            uint type=U32(b,start+position);if(type==UInt32.MaxValue)break;
            int attributeLength=(int)U32(b,start+position+4);
            if(attributeLength<24||position+attributeLength>used)throw new NtfsException("NTFS_INVALID_RECORD","Invalid attribute length");
            int at=start+position;bool nonResident=b[at+8]!=0;int nameLength=b[at+9];
            if(!nonResident) {
                int valueLength=(int)U32(b,at+16),valueOffset=U16(b,at+20),value=at+valueOffset;
                if(valueOffset<24||valueOffset+valueLength>attributeLength||valueLength<0)throw new NtfsException("NTFS_INVALID_RECORD","Invalid resident attribute");
                if(type==0x10&&valueLength>=36){node.Modified=TimeMs(I64(b,value+8));node.Attributes=U32(b,value+32);}
                else if(type==0x30&&valueLength>=66) {
                    int chars=b[value+64],space=b[value+65];
                    if(66+chars*2>valueLength)throw new NtfsException("NTFS_INVALID_RECORD","Invalid filename length");
                    string name=Encoding.Unicode.GetString(b,value+66,chars*2);
                    if(space!=2&&name!="."&&name.IndexOfAny(new char[]{'\\','/','\0'})<0) {
                        ulong parent=U64(b,value);bool duplicate=false;
                        foreach(var link in node.Links)if(link.Parent==parent&&link.Name==name){duplicate=true;break;}
                        if(!duplicate)node.Links.Add(new Link{Parent=parent,Name=name});
                    }
                }else if(type==0x80&&nameLength==0)node.Size=valueLength;
                else if(type==0x20){node.IncompleteNames=true;AttributeList(b,value,valueLength,node);}
            }else {
                if(attributeLength<64)throw new NtfsException("NTFS_INVALID_RECORD","Short nonresident attribute");
                if(type==0x80&&nameLength==0&&I64(b,at+16)==0)node.Size=I64(b,at+48);
                if(type==0x20) {
                    node.IncompleteNames=true;
                    var attribute=new byte[attributeLength];Buffer.BlockCopy(b,at,attribute,0,attributeLength);node.AttributeLists.Add(attribute);
                }
            }
            position+=attributeLength;
        }
        if(node.Directory)node.Attributes|=16;
        return true;
    }
    static bool ReadRecord(SafeFileHandle volume,ulong id,int recordSize,int sector,Dictionary<ulong,Node> nodes) {
        byte[] input=BitConverter.GetBytes(id),output=new byte[recordSize+16];int returned;
        if(!DeviceIoControl(volume,0x90068,input,input.Length,output,output.Length,out returned,IntPtr.Zero))throw new NtfsException("NTFS_RECORD_READ_FAILED","Cannot read changed MFT record: "+Marshal.GetLastWin32Error());
        if(returned<12)throw new NtfsException("NTFS_INVALID_BUFFER","Short file record response");
        if((U64(output,0)&0x0000ffffffffffffUL)!=(id&0x0000ffffffffffffUL))return false;
        int length=(int)U32(output,8);if(length>recordSize||12+length>returned)return false;
        if(length<48||U16(output,12+16)!=(ushort)(id>>48))return false;
        return ParseRecord(output,12,length,id&0x0000ffffffffffffUL,sector,nodes,true);
    }
    static byte[] ReadAttributeList(SafeFileHandle volume,byte[] attribute,int cluster,int sector,long volumeBytes) {
        long size=I64(attribute,48);int offset=U16(attribute,32);
        if(I64(attribute,16)!=0||size<0||size>16*1024*1024||offset<64||offset>=attribute.Length)throw new NtfsException("NTFS_INVALID_RECORD","Unsupported attribute list stream");
        var result=new byte[(int)size];int filled=0;long lcn=0;
        int alignment=Math.Max(cluster,65536);IntPtr memory=Marshal.AllocHGlobal(1024*1024+alignment);
        var pointer=new IntPtr((memory.ToInt64()+alignment-1)&~((long)alignment-1));
        try {
            while(offset<attribute.Length&&attribute[offset]!=0&&filled<result.Length) {
                int lengths=attribute[offset++],countBytes=lengths&15,deltaBytes=lengths>>4;
                if(countBytes<1||countBytes>8||deltaBytes<1||deltaBytes>8||offset+countBytes+deltaBytes>attribute.Length)throw new NtfsException("NTFS_INVALID_RECORD","Invalid attribute list mapping pairs");
                ulong clusters=0;for(int i=0;i<countBytes;i++)clusters|=(ulong)attribute[offset++]<<(8*i);
                long delta=(attribute[offset+deltaBytes-1]&128)!=0?-1L:0;
                for(int i=0;i<deltaBytes;i++){ulong mask=255UL<<(8*i);delta=(long)(((ulong)delta&~mask)|((ulong)attribute[offset++]<<(8*i)));}
                lcn=checked(lcn+delta);long available=checked((long)clusters*cluster),physical=checked(lcn*cluster);
                if(available<=0||physical<0||physical+available>volumeBytes)throw new NtfsException("NTFS_INVALID_RECORD","Invalid attribute list extent");
                while(available>0&&filled<result.Length) {
                    int take=(int)Math.Min(Math.Min(available,1024*1024),result.Length-filled),readSize=checked((take+cluster-1)/cluster*cluster),read;
                    long position;if(!SetFilePointerEx(volume,physical,out position,0)||!ReadFile(volume,pointer,readSize,out read,IntPtr.Zero)||read!=readSize)throw new NtfsException("NTFS_READ_FAILED","Cannot read attribute list: "+Marshal.GetLastWin32Error());
                    Marshal.Copy(pointer,result,filled,take);filled+=take;physical+=readSize;available-=readSize;
                }
            }
            if(filled!=result.Length)throw new NtfsException("NTFS_INVALID_RECORD","Incomplete attribute list stream");
            return result;
        }finally{Marshal.FreeHGlobal(memory);}
    }
    static void FileNames(SafeFileHandle volume,ulong id,Node node) {
        var descriptor=new byte[24];Put(descriptor,0,BitConverter.GetBytes((uint)24));Put(descriptor,8,BitConverter.GetBytes(id));
        using(var file=OpenFileById(volume,descriptor,0x80,7,IntPtr.Zero,0x02200000)) {
            FileInformation information;
            if(file.IsInvalid||!GetFileInformationByHandle(file,out information)||(((ulong)information.indexHigh<<32)|information.indexLow)!=id)throw new NtfsException("NTFS_RECORD_CHANGED","Cannot open changed identity for hardlink metadata");
            var full=new StringBuilder(32768);uint actual=GetFinalPathNameByHandleW(file,full,(uint)full.Capacity,0);
            if(actual==0||actual>=full.Capacity)throw new NtfsException("NTFS_RECORD_CHANGED","Cannot resolve hardlink metadata path");
            string canonical=full.ToString();int colon=canonical.IndexOf(':');
            if(colon<0)throw new NtfsException("NTFS_RECORD_CHANGED","Unsupported hardlink volume path");
            string root=canonical.Substring(0,colon+1)+"\\";var name=new StringBuilder(32768);uint length=(uint)name.Capacity;
            IntPtr find=FindFirstFileNameW(canonical,0,ref length,name);
            if(find==new IntPtr(-1))throw new NtfsException("NTFS_RECORD_CHANGED","Cannot enumerate hardlink names: "+Marshal.GetLastWin32Error());
            var links=new List<Link>();var parents=new Dictionary<string,ulong>(StringComparer.OrdinalIgnoreCase);
            try {
                do {
                    string target=root+name.ToString().TrimStart('\\');int separator=target.LastIndexOf('\\');string parent=separator==root.Length-1?root:target.Substring(0,separator),leaf=target.Substring(separator+1);ulong parentId;
                    if(!parents.TryGetValue(parent,out parentId)){parentId=RootId(parent);parents.Add(parent,parentId);}
                    links.Add(new Link{Parent=parentId,Name=leaf});length=(uint)name.Capacity;
                }while(FindNextFileNameW(find,ref length,name));
                int error=Marshal.GetLastWin32Error();if(error!=38)throw new NtfsException("NTFS_RECORD_CHANGED","Incomplete hardlink enumeration: "+error);
            }finally{FindClose(find);}
            node.Links=links;node.Size=((long)information.sizeHigh<<32)|information.sizeLow;
            node.Modified=TimeMs(((long)information.modifiedHigh<<32)|information.modifiedLow);node.Attributes=information.attributes;
        }
    }
    static Node ChangedRecord(SafeFileHandle volume,ulong id,byte[] geometry) {
        int recordSize=(int)U32(geometry,48),sector=(int)U32(geometry,40),cluster=(int)U32(geometry,44);
        var nodes=new Dictionary<ulong,Node>();Node node;
        if(!ReadRecord(volume,id,recordSize,sector,nodes)||!nodes.TryGetValue(id,out node))return null;
        var loaded=new HashSet<ulong>();loaded.Add(id);int streams=0;
        while(true) {
            while(streams<node.AttributeLists.Count) {
                byte[] bytes;
                try{bytes=ReadAttributeList(volume,node.AttributeLists[streams++],cluster,sector,checked(I64(geometry,16)*cluster));}
                catch(NtfsException error) {
                    if(error.Code!="NTFS_READ_FAILED")throw;
                    // Some volume filters reject raw reads. Resolve hardlinks through
                    // filesystem metadata rather than silently dropping extension names.
                    if(!node.Directory){FileNames(volume,id,node);node.IncompleteNames=false;return node;}
                    throw;
                }
                AttributeList(bytes,0,bytes.Length,node);
            }
            var pending=new List<ulong>();foreach(ulong reference in node.Extensions)if(!loaded.Contains(reference))pending.Add(reference);
            if(pending.Count==0)break;
            foreach(ulong reference in pending) {
                if(loaded.Count>=4096)throw new NtfsException("NTFS_INVALID_RECORD","Too many extension records");
                loaded.Add(reference);
                if(!ReadRecord(volume,reference,recordSize,sector,nodes))throw new NtfsException("NTFS_RECORD_CHANGED","Extension record changed during replay");
            }
        }
        node.IncompleteNames=false;return node;
    }
    static void EnumerateRecords(SafeFileHandle volume,byte[] geometry,Dictionary<ulong,Node> nodes) {
        long valid=I64(geometry,56);int recordSize=(int)U32(geometry,48),sector=(int)U32(geometry,40),total=0;
        if(valid<recordSize)throw new NtfsException("NTFS_INVALID_BUFFER","Empty MFT");
        ulong cursor=(ulong)(valid/recordSize-1);byte[] output=new byte[recordSize+16];
        while(true) {
            byte[] input=BitConverter.GetBytes(cursor);int returned;
            if(!DeviceIoControl(volume,0x90068,input,input.Length,output,output.Length,out returned,IntPtr.Zero)||returned<12)throw new NtfsException("NTFS_RECORD_READ_FAILED","Cannot enumerate MFT record "+cursor+": "+Marshal.GetLastWin32Error());
            ulong ordinal=U64(output,0)&0x0000ffffffffffffUL;int length=(int)U32(output,8);
            if(ordinal>cursor||length>recordSize||length<48||12+length>returned)throw new NtfsException("NTFS_INVALID_BUFFER","Invalid MFT enumeration cursor");
            ParseRecord(output,12,length,ordinal,sector,nodes,true);total++;
            if(total%8192==0)Send(new{type="progress",phase="enumerate-mft",bytesRead=valid-(long)ordinal*recordSize,mftBytes=valid,records=nodes.Count});
            if(ordinal==0)break;cursor=ordinal-1;
        }
    }
    static byte[] VolumeData(SafeFileHandle volume) {
        var output=new byte[128];int returned;
        if(!DeviceIoControl(volume,0x90064,null,0,output,output.Length,out returned,IntPtr.Zero)||returned<96)throw new NtfsException("NTFS_GEOMETRY_FAILED","Cannot query NTFS geometry");
        return output;
    }
    static List<long[]> MftRuns(string root) {
        var result=new List<long[]>();long requested=0;
        using(var mft=CreateFileW(root+"$MFT::$DATA",0x80,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
            if(mft.IsInvalid)throw new NtfsException("NTFS_MFT_UNAVAILABLE","Cannot open MFT metadata stream: "+Marshal.GetLastWin32Error());
            while(true) {
                byte[] input=BitConverter.GetBytes(requested),output=new byte[1024*1024];int returned;
                bool ok=DeviceIoControl(mft,0x90073,input,input.Length,output,output.Length,out returned,IntPtr.Zero);int error=ok?0:Marshal.GetLastWin32Error();
                if(!ok&&error!=234)throw new NtfsException("NTFS_EXTENTS_FAILED","Cannot read MFT extents: "+error);
                if(returned<16)throw new NtfsException("NTFS_INVALID_BUFFER","Short extent list");
                uint count=U32(output,0);if(count>(returned-16)/16)throw new NtfsException("NTFS_INVALID_BUFFER","Invalid extent count");
                long vcn=I64(output,8);
                for(int i=0;i<count;i++){long next=I64(output,16+i*16),lcn=I64(output,24+i*16);if(next<=vcn||lcn< -1)throw new NtfsException("NTFS_INVALID_BUFFER","Invalid extent");result.Add(new long[]{vcn,next,lcn});vcn=next;}
                if(ok)break;if(vcn<=requested)throw new NtfsException("NTFS_INVALID_BUFFER","Extent cursor did not advance");requested=vcn;
            }
        }
        return result;
    }
    static string DirectoryPath(ulong id,ulong rootId,string root,Dictionary<ulong,Node> nodes,Dictionary<ulong,string> cache,HashSet<ulong> visiting,int depth) {
        if(id==rootId)return root.TrimEnd('\\');string found;if(cache.TryGetValue(id,out found))return found;
        if(depth>512||!visiting.Add(id))return null;
        // Parent references describe actual entries on this volume. Resolving them
        // never follows a junction target, and also keeps cloud-directory children.
        Node node;if(!nodes.TryGetValue(id,out node)||!node.Directory||node.Links.Count==0){visiting.Remove(id);return null;}
        var link=node.Links[0];string parent=DirectoryPath(link.Parent,rootId,root,nodes,cache,visiting,depth+1);visiting.Remove(id);
        if(parent==null)return null;found=parent+"\\"+link.Name;cache[id]=found;return found;
    }
    static void Snapshot(string requestedRoot,bool rawRequested) {
        string root=ValidateRoot(requestedRoot);
        using(var volume=OpenVolume(root)) {
            byte[] journal=Journal(volume),geometry=VolumeData(volume);ulong rootId=RootId(root);
            int sector=(int)U32(geometry,40),cluster=(int)U32(geometry,44),recordSize=(int)U32(geometry,48);long valid=I64(geometry,56),volumeBytes=checked(I64(geometry,16)*cluster);
            if(sector<512||sector>65536||cluster<sector||recordSize<512||recordSize>65536||valid<0||valid%recordSize!=0)throw new NtfsException("NTFS_INVALID_BUFFER","Unsupported NTFS geometry");
            Send(new{type="volume",root=root,serial=Serial(root),rootId=rootId.ToString(),journalId=U64(journal,0).ToString(),nextUsn=I64(journal,16).ToString(),mftBytes=valid});
            var nodes=new Dictionary<ulong,Node>();List<long[]> runs=null;string strategy="mft-extents";
            // Driver records include pending NTFS cache updates. Raw extents are
            // available for diagnostics, but may lag behind the journal baseline.
            if(rawRequested)try{runs=MftRuns(root);}catch(NtfsException error){if(error.Code!="NTFS_EXTENTS_FAILED"&&error.Code!="NTFS_MFT_UNAVAILABLE")throw;}
            if(runs==null)strategy="mft-records";
            int capacity=8*1024*1024,alignment=Math.Max(cluster,65536);byte[] buffer=new byte[capacity];IntPtr allocation=Marshal.AllocHGlobal(capacity+alignment);long aligned=(allocation.ToInt64()+alignment-1)&~((long)alignment-1);var pointer=new IntPtr(aligned);long readBytes=0;int damaged=0;
            try {
                if(runs==null)EnumerateRecords(volume,geometry,nodes);
                else foreach(var run in runs) {
                    long logical=checked(run[0]*cluster),end=Math.Min(checked(run[1]*cluster),valid);if(logical>=end)continue;if(run[2]<0)continue;
                    long physical=checked(run[2]*cluster);
                    while(logical<end) {
                        int count=(int)Math.Min(capacity,end-logical);if(count%sector!=0||physical<0||physical+count>volumeBytes)throw new NtfsException("NTFS_INVALID_BUFFER","Invalid MFT read range");
                        long position;if(!SetFilePointerEx(volume,physical,out position,0))throw new NtfsException("NTFS_READ_FAILED","Cannot seek MFT extent");
                        int read;if(!ReadFile(volume,pointer,count,out read,IntPtr.Zero)||read!=count)throw new NtfsException("NTFS_READ_FAILED","Cannot read MFT extent: "+Marshal.GetLastWin32Error());
                        Marshal.Copy(pointer,buffer,0,read);
                        for(int offset=0;offset+recordSize<=read;offset+=recordSize) {
                            ulong ordinal=(ulong)((logical+offset)/recordSize);
                            try{ParseRecord(buffer,offset,recordSize,ordinal,sector,nodes);}catch(NtfsException){damaged++;}
                        }
                        logical+=read;physical+=read;readBytes+=read;
                        Send(new{type="progress",phase="read-mft",bytesRead=readBytes,mftBytes=valid,records=nodes.Count});
                    }
                }
            }finally{Marshal.FreeHGlobal(allocation);}
            var paths=new Dictionary<ulong,string>();var rows=new List<object[]>(512);int emitted=0,unresolved=0;
            // Resolve directory identities once; each file then needs one parent lookup.
            foreach(var pair in nodes)if(pair.Value.Directory)DirectoryPath(pair.Key,rootId,root,nodes,paths,new HashSet<ulong>(),0);
            foreach(var pair in nodes) {
                var node=pair.Value;if((node.Id&0x0000ffffffffffffUL)<16&&!node.Directory)continue;
                foreach(var link in node.Links) {
                    string parent=link.Parent==rootId?root.TrimEnd('\\'):null;
                    if(parent==null&&!paths.TryGetValue(link.Parent,out parent)){unresolved++;continue;}
                    string full=parent+"\\"+link.Name;
                    rows.Add(new object[]{node.Id.ToString(),link.Parent.ToString(),link.Name,node.Attributes,node.Directory?0:node.Size,node.Modified,full});emitted++;
                    if(rows.Count==512){Send(new{type="records",rows=rows});rows.Clear();}
                }
            }
            if(rows.Count>0)Send(new{type="records",rows=rows});
            byte[] after=Journal(volume);
            bool consistent=U64(after,0)==U64(journal,0)&&I64(after,8)<=I64(journal,16);
            Send(new{type="snapshot-end",root=root,serial=Serial(root),rootId=rootId.ToString(),journalId=U64(journal,0).ToString(),nextUsn=I64(journal,16).ToString(),records=emitted,damaged=damaged,unresolved=unresolved,strategy=strategy,complete=consistent&&damaged==0});
        }
    }
    static void Changes(Dictionary<string,object> request) {
        string root=ValidateRoot((string)request["root"]),serial=Serial(root);
        using(var volume=OpenVolume(root)) {
            byte[] journal=Journal(volume),geometry=VolumeData(volume);long start=Int64.Parse((string)request["nextUsn"]),target=I64(journal,16);ulong journalId=U64(journal,0);
            if(serial!=(string)request["serial"]||journalId.ToString()!=(string)request["journalId"]||start<I64(journal,8)||start>target){Send(new{type="reset",root=root,reason="journal-discontinuity"});return;}
            var changed=new HashSet<ulong>();int events=0;byte[] output=new byte[1024*1024];long cursor=start;
            while(cursor<target) {
                byte[] input=new byte[40];Buffer.BlockCopy(BitConverter.GetBytes(cursor),0,input,0,8);Buffer.BlockCopy(BitConverter.GetBytes(UInt32.MaxValue),0,input,8,4);Buffer.BlockCopy(BitConverter.GetBytes(journalId),0,input,32,8);int returned;
                if(!DeviceIoControl(volume,ReadJournal,input,input.Length,output,output.Length,out returned,IntPtr.Zero)){Send(new{type="reset",root=root,reason="journal-read-"+Marshal.GetLastWin32Error()});return;}
                if(returned<8)throw new NtfsException("NTFS_INVALID_BUFFER","Short USN buffer");long next=I64(output,0);if(next<=cursor)throw new NtfsException("NTFS_INVALID_BUFFER","USN cursor did not advance");
                int offset=8;
                while(offset<returned) {
                    if(offset+60>returned)throw new NtfsException("NTFS_INVALID_BUFFER","Short USN record");int length=(int)U32(output,offset);
                    if(length<60||offset+length>returned||U16(output,offset+4)!=2)throw new NtfsException("NTFS_UNSUPPORTED_RECORD","Unsupported USN record version or length");
                    ulong id=U64(output,offset+8),parent=U64(output,offset+16);long usn=I64(output,offset+24);uint reason=U32(output,offset+40);
                    int nameLength=U16(output,offset+56),nameOffset=U16(output,offset+58);if(nameOffset<60||nameOffset+nameLength>length||nameLength%2!=0)throw new NtfsException("NTFS_INVALID_BUFFER","Invalid journal filename");
                    if(usn<target){if((id&0x0000ffffffffffffUL)>=16)changed.Add(id);events++;}
                    offset+=length;
                }
                cursor=Math.Min(next,target);
                if(changed.Count>250000){Send(new{type="reset",root=root,reason="journal-backlog"});return;}
            }
            var rows=new List<object>();
            foreach(ulong id in changed) {
                Node node=ChangedRecord(volume,id,geometry);
                var links=new List<object[]>();if(node!=null)foreach(var link in node.Links)links.Add(new object[]{link.Parent.ToString(),link.Name});
                rows.Add(new{id=id.ToString(),deleted=node==null,attributes=node==null?0:node.Attributes,size=node==null?0:node.Size,modified=node==null?0:node.Modified,incompleteNames=node!=null&&node.IncompleteNames,links=links});
                if(rows.Count==256){Send(new{type="changes",rows=rows});rows.Clear();}
            }
            if(rows.Count>0)Send(new{type="changes",rows=rows});
            Send(new{type="journal-end",root=root,serial=serial,journalId=journalId.ToString(),nextUsn=target.ToString(),events=events,changed=changed.Count});
        }
    }
    static byte[] NumberInput(ulong start,long low,long high) {
        var data=new byte[24]; Buffer.BlockCopy(BitConverter.GetBytes(start),0,data,0,8);
        Buffer.BlockCopy(BitConverter.GetBytes(low),0,data,8,8); Buffer.BlockCopy(BitConverter.GetBytes(high),0,data,16,8); return data;
    }
    static string ValidateRoot(string root) {
        if (root==null || root.Length!=3 || !Char.IsLetter(root[0]) || root[1]!=':' || root[2]!='\\') throw new ArgumentException("A local drive root is required");
        return Char.ToUpperInvariant(root[0])+":\\";
    }
    static object Probe(string inputRoot) {
        string root=ValidateRoot(inputRoot);
        uint serial,maximum,flags; var fs=new StringBuilder(64); var label=new StringBuilder(256);
        if (!GetVolumeInformationW(root,label,label.Capacity,out serial,out maximum,out flags,fs,fs.Capacity)) return new { type="probe",root=root,available=false,error=Marshal.GetLastWin32Error() };
        if (fs.ToString()!="NTFS") return new { type="probe",root=root,available=false,filesystem=fs.ToString(),error=50 };
        int lastError=5;
        foreach(uint access in new uint[]{0,0x80000000}) {
            using(var volume=CreateFileW(@"\\.\"+root.Substring(0,2),access,7,IntPtr.Zero,3,0,IntPtr.Zero)) {
                if(volume.IsInvalid){lastError=Marshal.GetLastWin32Error();continue;}
                var journal=new byte[80]; int returned;
                if(!DeviceIoControl(volume,QueryJournal,null,0,journal,journal.Length,out returned,IntPtr.Zero)){lastError=Marshal.GetLastWin32Error();continue;}
                var data=NumberInput(0,0,Int64.MaxValue);var output=new byte[65536];
                bool snapshot=DeviceIoControl(volume,EnumUsn,data,data.Length,output,output.Length,out returned,IntPtr.Zero);
                int snapshotError=snapshot?0:Marshal.GetLastWin32Error();
                if(snapshot || access==0x80000000) return new {type="probe",root=root,available=snapshot,filesystem=fs.ToString(),serial=serial.ToString(),access=access,
                    journalId=BitConverter.ToUInt64(journal,0).ToString(),firstUsn=BitConverter.ToInt64(journal,8).ToString(),nextUsn=BitConverter.ToInt64(journal,16).ToString(),error=snapshotError};
                lastError=snapshotError;
            }
        }
        return new {type="probe",root=root,available=false,filesystem=fs.ToString(),serial=serial.ToString(),requiresElevation=lastError==5,error=lastError};
    }
    static bool Dispatch(Dictionary<string,object> request) {
        string operation=(string)request["op"];
        if(operation=="probe")Send(Probe((string)request["root"]));
        else if(operation=="snapshot") { SnapshotGate.Wait();try{Snapshot((string)request["root"],request.ContainsKey("raw")&&(bool)request["raw"]);}finally{SnapshotGate.Release();} }
        else if(operation=="journal")Changes(request);
        else if(operation=="identity")Send(new{type="identity",sid=WindowsIdentity.GetCurrent().User.Value,elevated=new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)});
        else if(operation=="shutdown"&&!PersistentConnection){Send(new{type="shutdown"});return false;}
        else throw new ArgumentException("Unsupported metadata operation");
        return true;
    }
    static void Put(byte[] b,int offset,byte[] value){Buffer.BlockCopy(value,0,b,offset,value.Length);}
    static int SelfTest() {
        var b=new byte[1024];Put(b,0,Encoding.ASCII.GetBytes("FILE"));Put(b,4,BitConverter.GetBytes((ushort)48));Put(b,6,BitConverter.GetBytes((ushort)3));
        Put(b,16,BitConverter.GetBytes((ushort)65535));Put(b,20,BitConverter.GetBytes((ushort)56));Put(b,22,BitConverter.GetBytes((ushort)1));
        Put(b,48,BitConverter.GetBytes((ushort)0xaaaa));Put(b,510,BitConverter.GetBytes((ushort)0xaaaa));Put(b,1022,BitConverter.GetBytes((ushort)0xaaaa));
        int at=56;Put(b,at,BitConverter.GetBytes((uint)0x10));Put(b,at+4,BitConverter.GetBytes((uint)72));Put(b,at+16,BitConverter.GetBytes((uint)48));Put(b,at+20,BitConverter.GetBytes((ushort)24));
        Put(b,at+24+8,BitConverter.GetBytes(116444736000000000L+1234560000L));Put(b,at+24+32,BitConverter.GetBytes((uint)32));at+=72;
        foreach(string name in new string[]{"报告.txt","报告副本.txt"}) {
            byte[] text=Encoding.Unicode.GetBytes(name);int value=66+text.Length,length=((24+value+7)/8)*8;
            Put(b,at,BitConverter.GetBytes((uint)0x30));Put(b,at+4,BitConverter.GetBytes((uint)length));Put(b,at+16,BitConverter.GetBytes((uint)value));Put(b,at+20,BitConverter.GetBytes((ushort)24));
            Put(b,at+24,BitConverter.GetBytes((ulong)5));b[at+24+64]=(byte)name.Length;b[at+24+65]=3;Put(b,at+24+66,text);at+=length;
        }
        Put(b,at,BitConverter.GetBytes((uint)0x80));Put(b,at+4,BitConverter.GetBytes((uint)32));Put(b,at+16,BitConverter.GetBytes((uint)7));Put(b,at+20,BitConverter.GetBytes((ushort)24));at+=32;
        Put(b,at,BitConverter.GetBytes(UInt32.MaxValue));Put(b,24,BitConverter.GetBytes((uint)(at+8)));
        var nodes=new Dictionary<ulong,Node>();ParseRecord(b,0,b.Length,42,512,nodes);ulong id=42UL|(65535UL<<48);Node node=nodes[id];
        if(node.Size!=7||node.Modified!=123456||node.Links.Count!=2||node.Links[0].Name!="报告.txt")throw new Exception("MFT metadata self-test failed");
        bool rejected=false;Put(b,1022,BitConverter.GetBytes((ushort)0xffff));try{ParseRecord(b,0,b.Length,42,512,new Dictionary<ulong,Node>());}catch(NtfsException){rejected=true;}
        if(!rejected)throw new Exception("Torn record was accepted");
        var fixedNodes=new Dictionary<ulong,Node>();ParseRecord(b,0,b.Length,42,4096,fixedNodes,true);
        if(fixedNodes[id].Modified!=123456)throw new Exception("Driver-fixed record was corrupted");
        Send(new{type="selftest",passed=6,checks=new string[]{"full-width-reference","resident-size","SI-modified-time","hardlink-names","torn-record-rejection","driver-fixed-record"}});return 0;
    }
    static bool Run(TextReader input) {
        string line;
        while((line=input.ReadLine())!=null) {
            bool keep=true;
            try{keep=Dispatch(Json.Deserialize<Dictionary<string,object>>(line));}
            catch(Exception error){var ntfs=error as NtfsException;Send(new{type="error",code=ntfs==null?"NTFS_ERROR":ntfs.Code,message=error.Message});}
            Send(new{type="done"});if(!keep)return false;
        }
        return true;
    }
    static int Serve(string name,string token,string sid) {
        if(!name.StartsWith("DiskSenseNtfs-")||name.Length>120||token.Length!=64)throw new ArgumentException("Invalid broker identity");
        var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid),PipeAccessRights.ReadWrite,AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid,null),PipeAccessRights.FullControl,AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));
        while(true) {
            using(var pipe=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,65536,65536,security)) {
                var connection=pipe.BeginWaitForConnection(null,null);
                if(!connection.AsyncWaitHandle.WaitOne(TimeSpan.FromHours(4)))return 0;
                pipe.EndWaitForConnection(connection);
                try {
                    using(var input=new StreamReader(pipe,new UTF8Encoding(false),false,65536,true))
                    using(var output=new StreamWriter(pipe,new UTF8Encoding(false),65536,true)) {
                        Output=output;
                        var hello=Json.Deserialize<Dictionary<string,object>>(input.ReadLine()??"{}");
                        if(!hello.ContainsKey("token")||(string)hello["token"]!=token){Send(new{type="error",code="NTFS_AUTH_FAILED",message="Broker authentication failed"});continue;}
                        Send(new{type="hello",protocol=1,elevated=new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)});
                        if(!Run(input))return 0;
                    }
                }catch(IOException){}catch(ObjectDisposedException){}finally{Output=Console.Out;}
            }
        }
    }
    static int Main(string[] args) {
        if(args.Length>0&&args[0]=="--windows-service")return ServiceCommand(args);
        Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
        if(args.Length>0&&args[0].StartsWith("--service-"))return ServiceCommand(args);
        if(args.Length==1&&args[0]=="--selftest")return SelfTest();
        if(args.Length==4&&args[0]=="--launch") {
            try {
                new SecurityIdentifier(args[3]);
                if(!args[1].StartsWith("DiskSenseNtfs-")||args[1].Length>120||!System.Text.RegularExpressions.Regex.IsMatch(args[1],"^[A-Za-z0-9-]+$")||!System.Text.RegularExpressions.Regex.IsMatch(args[2],"^[a-f0-9]{64}$"))throw new ArgumentException("Invalid launch identity");
                var start=new ProcessStartInfo{FileName=System.Reflection.Assembly.GetExecutingAssembly().Location,Arguments="--serve "+args[1]+" "+args[2]+" "+args[3],UseShellExecute=true,Verb="runas",WindowStyle=ProcessWindowStyle.Hidden};
                using(var process=Process.Start(start))Send(new{type="launched",pid=process.Id});
                return 0;
            }catch(Win32Exception error){Send(new{type="error",code=error.NativeErrorCode==1223?"NTFS_ELEVATION_CANCELLED":"NTFS_LAUNCH_FAILED",message=error.Message});return 1;}
        }
        if(args.Length==4&&args[0]=="--serve")return Serve(args[1],args[2],args[3]);
        Run(Console.In);return 0;
    }
}
