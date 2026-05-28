# generate_icons.ps1 — Suriin AI Scanner
# ============================================================
# Generates icon16.png, icon48.png, icon128.png using .NET
# System.Drawing — no external tools required.
#
# Run from the project root:
#   powershell -ExecutionPolicy Bypass -File generate_icons.ps1
# ============================================================

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Drawing.Primitives -ErrorAction SilentlyContinue

# Ensure the icons directory exists
$iconsDir = Join-Path $PSScriptRoot "icons"
if (-not (Test-Path $iconsDir)) {
    New-Item -ItemType Directory -Path $iconsDir | Out-Null
    Write-Host "[OK] Created icons/ directory"
}

# ── Icon sizes required by manifest.json ───────────────────
$sizes = @(16, 48, 128)

foreach ($size in $sizes) {
    # Create a new Bitmap with the target size
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)

    # Enable anti-aliasing for smooth curves
    $g.SmoothingMode   = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # ── Background (rounded square) ───────────────────────
    $bgColor = [System.Drawing.Color]::FromArgb(255, 15, 14, 23)   # #0F0E17
    $g.Clear($bgColor)

    # ── Shield body (simplified polygon) ─────────────────
    # We draw the shield as a filled path scaled to icon size
    $pad   = [int]($size * 0.10)      # 10% padding
    $iw    = $size - ($pad * 2)       # inner width
    $ih    = $size - ($pad * 2)       # inner height

    # Approx shield points (scaled): top-center, top-right, mid-right,
    # bottom-center, mid-left, top-left
    $cx    = $size / 2
    $top   = $pad
    $bot   = $size - [int]($size * 0.06)
    $midY  = $top + [int]($ih * 0.42)

    $shieldPoints = @(
        [System.Drawing.PointF]::new($cx,                 $top              ),  # top center
        [System.Drawing.PointF]::new($pad + $iw,          $top + $ih * 0.18 ),  # top right
        [System.Drawing.PointF]::new($pad + $iw,          $midY             ),  # mid right
        [System.Drawing.PointF]::new($cx,                 $bot              ),  # bottom center
        [System.Drawing.PointF]::new($pad,                $midY             ),  # mid left
        [System.Drawing.PointF]::new($pad,                $top + $ih * 0.18 )   # top left
    )

    # Gradient fill: purple (#6C63FF) → teal (#3ECFCF)
    $gradBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        [System.Drawing.PointF]::new(0, 0),
        [System.Drawing.PointF]::new($size, $size),
        [System.Drawing.Color]::FromArgb(255, 108, 99, 255),   # #6C63FF
        [System.Drawing.Color]::FromArgb(255, 62, 207, 207)    # #3ECFCF
    )

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddPolygon($shieldPoints)
    $g.FillPath($gradBrush, $path)

    # ── Checkmark (white) ─────────────────────────────────
    if ($size -ge 24) {
        $penWidth = [float][Math]::Max(1.5, $size * 0.06)
        $wPen     = New-Object System.Drawing.Pen([System.Drawing.Color]::White, $penWidth)
        $wPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $wPen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round

        # Checkmark points scaled to icon size
        $ck1 = [System.Drawing.PointF]::new($cx - $iw*0.18, $midY + $ih*0.02)
        $ck2 = [System.Drawing.PointF]::new($cx - $iw*0.02, $midY + $ih*0.15)
        $ck3 = [System.Drawing.PointF]::new($cx + $iw*0.22, $midY - $ih*0.12)

        $g.DrawLine($wPen, $ck1, $ck2)
        $g.DrawLine($wPen, $ck2, $ck3)
        $wPen.Dispose()
    }

    # ── Save the PNG ──────────────────────────────────────
    $outPath = Join-Path $iconsDir "icon$size.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)

    # Cleanup
    $gradBrush.Dispose()
    $path.Dispose()
    $g.Dispose()
    $bmp.Dispose()

    Write-Host "[OK] icons/icon$size.png"
}

Write-Host ""
Write-Host "All icons generated successfully in: $iconsDir"
