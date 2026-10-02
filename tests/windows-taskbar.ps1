param(
    [Parameter(Mandatory = $true)]
    [long] $Hwnd,
    [string] $OutputDirectory
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct PropertyKey
{
    public Guid FormatId;
    public uint PropertyId;
}

[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct PropVariant
{
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public IntPtr Value;
}

[ComImport]
[Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore
{
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
}

public static class WindowTaskbarProbe
{
    private static readonly Guid AppUserModelFormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    private static readonly Guid PropertyStoreInterfaceId = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);

    [DllImport("ole32.dll", PreserveSig = true)]
    private static extern int PropVariantClear(ref PropVariant value);

    public static Dictionary<string, object> Read(IntPtr hwnd, string outputDirectory)
    {
        if (!IsWindow(hwnd))
            throw new ArgumentException("The HWND does not identify a live window.", "hwnd");

        uint processId;
        GetWindowThreadProcessId(hwnd, out processId);

        IPropertyStore store;
        Guid iid = PropertyStoreInterfaceId;
        Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(hwnd, ref iid, out store));

        try
        {
            Dictionary<string, object> result = new Dictionary<string, object>
            {
                { "hwnd", hwnd.ToInt64() },
                { "processId", processId },
                { "appUserModelId", ReadString(store, 5) },
                { "relaunchCommand", ReadString(store, 2) },
                { "relaunchDisplayNameResource", ReadString(store, 4) },
                { "relaunchIconResource", ReadString(store, 3) }
            };

            if (!String.IsNullOrEmpty(outputDirectory))
            {
                outputDirectory = Path.GetFullPath(outputDirectory);
                Directory.CreateDirectory(outputDirectory);
                result.Add("windowIconBig", SaveWindowIcon(hwnd, 1, Path.Combine(outputDirectory, "window-icon-big.png")));
                result.Add("windowIconSmall", SaveWindowIcon(hwnd, 0, Path.Combine(outputDirectory, "window-icon-small.png")));
                result.Add("executableIcon", SaveExecutableIcon(processId, Path.Combine(outputDirectory, "executable-icon.png")));
            }

            return result;
        }
        finally
        {
            Marshal.ReleaseComObject(store);
        }
    }

    private static string SaveWindowIcon(IntPtr hwnd, int kind, string path)
    {
        IntPtr icon;
        if (SendMessageTimeout(hwnd, 0x7F, new IntPtr(kind), IntPtr.Zero, 2, 1000, out icon) == IntPtr.Zero || icon == IntPtr.Zero)
            return null;

        using (Bitmap bitmap = Bitmap.FromHicon(icon))
            bitmap.Save(path, ImageFormat.Png);
        return path;
    }

    private static string SaveExecutableIcon(uint processId, string path)
    {
        using (Process process = Process.GetProcessById((int)processId))
        using (Icon icon = Icon.ExtractAssociatedIcon(process.MainModule.FileName))
        using (Bitmap bitmap = icon.ToBitmap())
            bitmap.Save(path, ImageFormat.Png);
        return path;
    }

    private static string ReadString(IPropertyStore store, uint propertyId)
    {
        PropertyKey key = new PropertyKey { FormatId = AppUserModelFormatId, PropertyId = propertyId };
        PropVariant value;
        Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));

        try
        {
            if (value.Type == 0)
                return null;
            if (value.Type == 31)
                return Marshal.PtrToStringUni(value.Value);
            if (value.Type == 8)
                return Marshal.PtrToStringBSTR(value.Value);
            throw new InvalidOperationException("Unexpected PROPVARIANT type " + value.Type + " for property " + propertyId + ".");
        }
        finally
        {
            Marshal.ThrowExceptionForHR(PropVariantClear(ref value));
        }
    }
}
'@ -ReferencedAssemblies 'System.Drawing'

[WindowTaskbarProbe]::Read([IntPtr]::new($Hwnd), $OutputDirectory) | ConvertTo-Json -Compress -Depth 3
