# Raise the GitHub-hosted Windows desktop so a 1280x720 client window fits, and quiet toasts.
# gdigrab records this interactive session. A session with no display cannot be captured.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

function Set-CaptureResolution([int] $Width, [int] $Height) {
  $code = @'
using System;
using System.Runtime.InteropServices;
namespace FaibotsCapture {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion;
    public short dmDriverVersion;
    public short dmSize;
    public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public int dmDisplayOrientation;
    public int dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel;
    public int dmPelsWidth;
    public int dmPelsHeight;
    public int dmDisplayFlags;
    public int dmDisplayFrequency;
    public int dmICMMethod;
    public int dmICMIntent;
    public int dmMediaType;
    public int dmDitherType;
    public int dmReserved1;
    public int dmReserved2;
    public int dmPanningWidth;
    public int dmPanningHeight;
  }
  public static class Display {
    [DllImport("user32.dll", CharSet = CharSet.Ansi)]
    public static extern int EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);
    [DllImport("user32.dll", CharSet = CharSet.Ansi)]
    public static extern int ChangeDisplaySettings(ref DEVMODE devMode, int flags);
    public static string Change(int width, int height) {
      DEVMODE dm = new DEVMODE();
      dm.dmDeviceName = new string('\0', 32);
      dm.dmFormName = new string('\0', 32);
      dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
      if (EnumDisplaySettings(null, -1, ref dm) == 0) return "Could not read the current display mode.";
      dm.dmPelsWidth = width;
      dm.dmPelsHeight = height;
      dm.dmFields = 0x80000 | 0x100000;
      int test = ChangeDisplaySettings(ref dm, 2);
      if (test != 0) return "Test change failed with code " + test + ".";
      int changed = ChangeDisplaySettings(ref dm, 1);
      if (changed != 0) return "Change failed with code " + changed + ".";
      return "ok";
    }
  }
}
'@
  Add-Type -TypeDefinition $code -Language CSharp -ErrorAction Stop
  return [FaibotsCapture.Display]::Change($Width, $Height)
}

$toast = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications'
New-Item -Path $toast -Force | Out-Null
New-ItemProperty -Path $toast -Name ToastEnabled -Value 0 -PropertyType DWord -Force | Out-Null

$logPixels = (Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name LogPixels -ErrorAction SilentlyContinue).LogPixels
Write-Output "LogPixels=$logPixels"

$screen = [System.Windows.Forms.Screen]::PrimaryScreen
if ($null -eq $screen) {
  throw 'No interactive desktop is available. gdigrab cannot record a faibots window on this runner.'
}
Write-Output ("Desktop {0}x{1}, work area {2}x{3}" -f $screen.Bounds.Width, $screen.Bounds.Height, $screen.WorkingArea.Width, $screen.WorkingArea.Height)

if ($screen.Bounds.Width -lt 1600 -or $screen.Bounds.Height -lt 900) {
  $result = Set-CaptureResolution 1920 1080
  Write-Output "Resolution change: $result"
  Start-Sleep -Seconds 1
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen
  Write-Output ("Desktop now {0}x{1}, work area {2}x{3}" -f $screen.Bounds.Width, $screen.Bounds.Height, $screen.WorkingArea.Width, $screen.WorkingArea.Height)
}

if ($screen.Bounds.Width -lt 1400 -or $screen.Bounds.Height -lt 800) {
  throw "The interactive desktop is $($screen.Bounds.Width)x$($screen.Bounds.Height), too small for a 1280x720 client window plus the title bar."
}
