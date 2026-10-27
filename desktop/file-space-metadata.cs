using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Metadata only: no read-data access, no directory traversal, no following reparse points.
internal static class FileSpaceMetadata {
  [StructLayout(LayoutKind.Sequential)] struct AttrData {
    public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write;
    public uint sizeHigh, sizeLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct ByHandle {
    public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct Standard {
    public long allocation, length; public uint links;
    [MarshalAs(UnmanagedType.U1)] public bool deletePending;
    [MarshalAs(UnmanagedType.U1)] public bool directory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Compression {
    public long compressedSize; public ushort format;
    public byte unitShift, chunkShift, clusterShift, reserved1, reserved2, reserved3;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetFileAttributesEx(string path, int level, out AttrData data);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandle info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out Standard info, uint size);
  [DllImport("kernel32.dll", EntryPoint="GetFileInformationByHandleEx", SetLastError=true)] static extern bool CompressionInfo(SafeFileHandle handle, int infoClass, out Compression info, uint size);
  static string Extended(string value) {
    if (value.StartsWith(@"\\?\")) return value;
    return value.StartsWith(@"\\") ? @"\\?\UNC\" + value.Substring(2) : @"\\?\" + value;
  }
  static object Inspect(string file) {
    var r = new Dictionary<string, object>(); r["path"] = file;
    AttrData a;
    if (!GetFileAttributesEx(Extended(file), 0, out a)) { r["errorCode"] = Marshal.GetLastWin32Error(); return r; }
    r["logicalBytes"] = ((ulong)a.sizeHigh << 32) | a.sizeLow;
    r["attributes"] = a.attributes;
    r["directory"] = (a.attributes & 16) != 0;
    bool cloud = (a.attributes & (4096 | 262144 | 4194304)) != 0;
    r["cloudPlaceholder"] = cloud;
    // Opening a recall-on-open placeholder can fetch data. Report unknown allocation instead.
    if (cloud || (a.attributes & 1024) != 0) { r["skipped"] = cloud ? "cloud-placeholder" : "reparse-point"; return r; }
    using (var h = CreateFile(Extended(file), 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (h.IsInvalid) { r["errorCode"] = Marshal.GetLastWin32Error(); return r; }
      ByHandle b; Standard s;
      if (!GetFileInformationByHandle(h, out b) || !GetFileInformationByHandleEx(h, 1, out s, (uint)Marshal.SizeOf(typeof(Standard)))) { r["errorCode"] = Marshal.GetLastWin32Error(); return r; }
      // Reject an object replaced by a reparse point between attribute lookup and handle open.
      if ((b.attributes & 1024) != 0) { r["skipped"] = "reparse-point"; return r; }
      r["identity"] = b.volume.ToString("x8") + ":" + b.indexHigh.ToString("x8") + b.indexLow.ToString("x8");
      r["linkCount"] = b.links; r["logicalBytes"] = s.length; r["directory"] = s.directory;
      if (!s.directory) {
        long allocated = s.allocation;
        if ((b.attributes & (512 | 2048)) != 0) {
          Compression c;
          if (!CompressionInfo(h, 8, out c, (uint)Marshal.SizeOf(typeof(Compression)))) { r["errorCode"] = Marshal.GetLastWin32Error(); return r; }
          allocated = c.compressedSize;
        }
        r["allocatedBytes"] = allocated;
      }
    }
    return r;
  }
  public static int Main() {
    try {
      Console.InputEncoding = new System.Text.UTF8Encoding(false);
      var json = new JavaScriptSerializer();
      var paths = json.Deserialize<string[]>(Console.In.ReadToEnd());
      if (paths == null || paths.Length > 128) return 2;
      var rows = new List<object>();
      foreach (var p in paths) {
        if (String.IsNullOrEmpty(p) || !Path.IsPathRooted(p) || p.IndexOf('\0') >= 0) return 2;
        rows.Add(Inspect(p));
      }
      Console.OutputEncoding = new System.Text.UTF8Encoding(false);
      Console.Write(json.Serialize(rows)); return 0;
    } catch { return 1; }
  }
}
