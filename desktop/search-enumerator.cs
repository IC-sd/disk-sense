// Original Win32 metadata enumeration; reparse points are never followed.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

class DirectoryEnumerator {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct FindData {
        public uint attributes;
        public uint createdLow, createdHigh, accessedLow, accessedHigh, modifiedLow, modifiedHigh;
        public uint sizeHigh, sizeLow, reserved0, reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string shortName;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr FindFirstFileExW(string pattern, int level, out FindData data, int search, IntPtr filter, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool FindNextFileW(IntPtr handle, out FindData data);
    [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFileAttributesW(string path);
    static JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
    static void Send(List<object[]> rows, bool done, int error) {
        Console.WriteLine(json.Serialize(new { rows = rows, done = done, error = error }));
        Console.Out.Flush();
    }
    static void Enumerate(string directory) {
        string extended = directory.StartsWith(@"\\?\") ? directory :
            directory.StartsWith(@"\\") ? @"\\?\UNC\" + directory.Substring(2) : @"\\?\" + directory;
        var rows = new List<object[]>(512);
        uint attributes = GetFileAttributesW(extended);
        if (attributes == UInt32.MaxValue) { Send(rows, true, Marshal.GetLastWin32Error()); return; }
        if ((attributes & 0x400) != 0) { Send(rows, true, 4390); return; }
        FindData data;
        var handle = FindFirstFileExW(extended.TrimEnd('\\') + @"\*", 1, out data, 0, IntPtr.Zero, 2);
        if (handle == new IntPtr(-1)) {
            int error = Marshal.GetLastWin32Error();
            Send(rows, true, error == 2 || error == 18 ? 0 : error); return;
        }
        try {
            do {
                if (data.name == "." || data.name == "..") continue;
                long fileTime = (long)(((ulong)data.modifiedHigh << 32) | data.modifiedLow);
                long modified = fileTime >= 116444736000000000L ? (fileTime - 116444736000000000L) / 10000 : 0;
                rows.Add(new object[] { data.name, data.attributes, ((ulong)data.sizeHigh << 32) | data.sizeLow, modified });
                if (rows.Count == 512) { Send(rows, false, 0); rows.Clear(); }
            } while (FindNextFileW(handle, out data));
            int error = Marshal.GetLastWin32Error();
            Send(rows, true, error == 18 ? 0 : error);
        } finally { FindClose(handle); }
    }
    static int Main() {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        string line;
        while ((line = Console.ReadLine()) != null) {
            try { Enumerate(json.Deserialize<string>(line)); }
            catch { Send(new List<object[]>(), true, -1); }
        }
        return 0;
    }
}
