Add-Type -AssemblyName System.Drawing

$size = 512
$bitmap = [System.Drawing.Bitmap]::new($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

$bounds = [System.Drawing.RectangleF]::new(20, 20, 472, 472)
$radius = 112
$path = [System.Drawing.Drawing2D.GraphicsPath]::new()
$diameter = $radius * 2
$path.AddArc($bounds.X, $bounds.Y, $diameter, $diameter, 180, 90)
$path.AddArc($bounds.Right - $diameter, $bounds.Y, $diameter, $diameter, 270, 90)
$path.AddArc($bounds.Right - $diameter, $bounds.Bottom - $diameter, $diameter, $diameter, 0, 90)
$path.AddArc($bounds.X, $bounds.Bottom - $diameter, $diameter, $diameter, 90, 90)
$path.CloseFigure()

$background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.PointF]::new(50, 40),
  [System.Drawing.PointF]::new(460, 480),
  [System.Drawing.Color]::FromArgb(255, 28, 55, 94),
  [System.Drawing.Color]::FromArgb(255, 7, 17, 30)
)
$graphics.FillPath($background, $path)

$orbitPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(150, 106, 143, 255), 18)
$orbitPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$orbitPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawArc($orbitPen, 102, 103, 308, 308, 200, 278)

$diskBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 83, 219, 161))
$graphics.FillEllipse($diskBrush, 174, 174, 164, 164)
$innerBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 10, 30, 42))
$graphics.FillEllipse($innerBrush, 222, 222, 68, 68)

$sparkBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 235, 244, 255))
$spark = [System.Drawing.PointF[]]@(
  [System.Drawing.PointF]::new(375, 72),
  [System.Drawing.PointF]::new(390, 109),
  [System.Drawing.PointF]::new(428, 124),
  [System.Drawing.PointF]::new(390, 139),
  [System.Drawing.PointF]::new(375, 177),
  [System.Drawing.PointF]::new(360, 139),
  [System.Drawing.PointF]::new(322, 124),
  [System.Drawing.PointF]::new(360, 109)
)
$graphics.FillPolygon($sparkBrush, $spark)

$output = Join-Path $PSScriptRoot '..\build\icon.png'
[System.IO.Directory]::CreateDirectory((Split-Path $output)) | Out-Null
$bitmap.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)

$iconBitmap = [System.Drawing.Bitmap]::new(256, 256)
$iconGraphics = [System.Drawing.Graphics]::FromImage($iconBitmap)
$iconGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$iconGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$iconGraphics.DrawImage($bitmap, 0, 0, 256, 256)
$memory = [System.IO.MemoryStream]::new()
$iconBitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $memory.ToArray()

$iconOutput = Join-Path $PSScriptRoot '..\build\icon.ico'
$stream = [System.IO.File]::Open($iconOutput, [System.IO.FileMode]::Create)
$writer = [System.IO.BinaryWriter]::new($stream)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]1)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([Byte]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]32)
$writer.Write([UInt32]$pngBytes.Length)
$writer.Write([UInt32]22)
$writer.Write($pngBytes)
$writer.Dispose()
$stream.Dispose()
$memory.Dispose()
$iconGraphics.Dispose()
$iconBitmap.Dispose()

$sparkBrush.Dispose()
$innerBrush.Dispose()
$diskBrush.Dispose()
$orbitPen.Dispose()
$background.Dispose()
$path.Dispose()
$graphics.Dispose()
$bitmap.Dispose()
