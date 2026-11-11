// Makes Wtv's icons and store images from the artwork in brand/source/. macOS only
// (CoreGraphics); run from the repo root after changing the artwork:
//
//   npm run icons        (swift -O scripts/brand/icons.swift)
//
// The artwork is a rounded TV on black. The black around it becomes transparent (a flood
// fill from the edges, so black inside the TV stays black), the TV is cropped to a square,
// and then:
//
//   brand/wtv-*.png               the cut-out artwork at full size (the masters)
//   public/icon/<size>.png        the manifest icons and the toolbar button (shipped)
//   public/wtv-logo*.png          the logo for the popup header and Credits dialog (shipped)
//   brand/store/*.png             for the Chrome Web Store and Edge Add-ons dashboards
//
// Which artwork goes where is in OUTPUTS below.
import CoreGraphics
import Foundation
import ImageIO

/// Black at or under this (brightest channel) is background; dimmer is more transparent.
let threshold = 40

struct Bitmap {
  var width: Int
  var height: Int
  /// RGBA, premultiplied.
  var pixels: [UInt8]
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("icons: \(message)\n".data(using: .utf8)!)
  exit(1)
}

func load(_ path: String) -> Bitmap {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("can't read \(path)") }
  let w = image.width, h = image.height
  var pixels = [UInt8](repeating: 0, count: w * h * 4)
  pixels.withUnsafeMutableBytes { buf in
    let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
  }
  return Bitmap(width: w, height: h, pixels: pixels)
}

func cgImage(_ b: Bitmap) -> CGImage {
  var pixels = b.pixels
  return pixels.withUnsafeMutableBytes { buf in
    let ctx = CGContext(data: buf.baseAddress, width: b.width, height: b.height, bitsPerComponent: 8, bytesPerRow: b.width * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    return ctx.makeImage()!
  }
}

func save(_ image: CGImage, _ path: String) {
  try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
  guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil) else {
    fail("can't write \(path)")
  }
  CGImageDestinationAddImage(dest, image, nil)
  if !CGImageDestinationFinalize(dest) { fail("can't write \(path)") }
  print("  \(path)  \(image.width)×\(image.height)")
}

/// The black around the TV, made transparent: flood fill from the edges. The artwork's
/// edge is anti-aliased against black, so a pixel's brightness there is its coverage, and
/// its colour is already premultiplied: only alpha needs setting.
func cutOut(_ b: inout Bitmap) {
  let w = b.width, h = b.height
  var seen = [Bool](repeating: false, count: w * h)
  var stack: [Int] = []
  func brightness(_ i: Int) -> Int { max(Int(b.pixels[i * 4]), Int(b.pixels[i * 4 + 1]), Int(b.pixels[i * 4 + 2])) }
  func push(_ i: Int) {
    if !seen[i] && brightness(i) <= threshold { seen[i] = true; stack.append(i) }
  }
  for x in 0..<w { push(x); push((h - 1) * w + x) }
  for y in 0..<h { push(y * w); push(y * w + w - 1) }
  while let i = stack.popLast() {
    b.pixels[i * 4 + 3] = UInt8(min(255, brightness(i) * 255 / threshold))
    let x = i % w, y = i / w
    if x > 0 { push(i - 1) }
    if x < w - 1 { push(i + 1) }
    if y > 0 { push(i - w) }
    if y < h - 1 { push(i + w) }
  }
}

/// The smallest square around what isn't transparent, centred.
func cropSquare(_ b: Bitmap) -> Bitmap {
  var minX = b.width, minY = b.height, maxX = -1, maxY = -1
  for y in 0..<b.height {
    for x in 0..<b.width where b.pixels[(y * b.width + x) * 4 + 3] > 8 {
      minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    }
  }
  if maxX < 0 { fail("the artwork is all black") }
  let side = max(maxX - minX + 1, maxY - minY + 1)
  let left = minX - (side - (maxX - minX + 1)) / 2
  let top = minY - (side - (maxY - minY + 1)) / 2
  var out = Bitmap(width: side, height: side, pixels: [UInt8](repeating: 0, count: side * side * 4))
  for y in 0..<side {
    for x in 0..<side {
      let sx = left + x, sy = top + y
      guard sx >= 0, sy >= 0, sx < b.width, sy < b.height else { continue }
      let s = (sy * b.width + sx) * 4, d = (y * side + x) * 4
      for c in 0..<4 { out.pixels[d + c] = b.pixels[s + c] }
    }
  }
  return out
}

/// Premultiplied RGBA as 0...1 floats, for resampling.
struct FloatBitmap {
  var width: Int
  var height: Int
  var px: [Float]
}

func floats(_ image: CGImage) -> FloatBitmap {
  let w = image.width, h = image.height
  var bytes = [UInt8](repeating: 0, count: w * h * 4)
  bytes.withUnsafeMutableBytes { buf in
    let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
  }
  return FloatBitmap(width: w, height: h, px: bytes.map { Float($0) / 255 })
}

func cgImage(_ b: FloatBitmap) -> CGImage {
  var bytes = b.px.map { UInt8(max(0, min(255, ($0 * 255).rounded()))) }
  // Premultiplied: no channel brighter than alpha.
  for i in stride(from: 0, to: bytes.count, by: 4) {
    for c in 0..<3 { bytes[i + c] = min(bytes[i + c], bytes[i + 3]) }
  }
  return cgImage(Bitmap(width: b.width, height: b.height, pixels: bytes))
}

/// Each output pixel is the exact average of the source area under it (a box filter over
/// its footprint, partial pixels weighted). For big reductions this beats CoreGraphics'
/// interpolation, which blurred and darkened the toolbar sizes. Separable: rows, then columns.
func areaAverage(_ b: FloatBitmap, _ ow: Int, _ oh: Int) -> FloatBitmap {
  func pass(_ src: [Float], _ sw: Int, _ sh: Int, _ out: Int, horizontal: Bool) -> [Float] {
    let n = horizontal ? sw : sh, lines = horizontal ? sh : sw
    let scale = Double(n) / Double(out)
    var dst = [Float](repeating: 0, count: (horizontal ? out * sh : sw * out) * 4)
    for o in 0..<out {
      let from = Double(o) * scale, to = Double(o + 1) * scale
      var weights: [(Int, Float)] = []
      var i = Int(from)
      while Double(i) < to && i < n {
        weights.append((i, Float((min(to, Double(i + 1)) - max(from, Double(i))) / scale)))
        i += 1
      }
      for k in 0..<lines {
        var r: Float = 0, g: Float = 0, bl: Float = 0, a: Float = 0
        for (i, w) in weights {
          let s = (horizontal ? k * sw + i : i * sw + k) * 4
          r += src[s] * w; g += src[s + 1] * w; bl += src[s + 2] * w; a += src[s + 3] * w
        }
        let d = (horizontal ? k * out + o : o * sw + k) * 4
        dst[d] = r; dst[d + 1] = g; dst[d + 2] = bl; dst[d + 3] = a
      }
    }
    return dst
  }
  let rows = pass(b.px, b.width, b.height, ow, horizontal: true)
  return FloatBitmap(width: ow, height: oh, px: pass(rows, ow, b.height, oh, horizontal: false))
}

/// Unsharp mask over a 3×3 neighbourhood: brings back the edges averaging softens.
func sharpen(_ b: FloatBitmap, _ amount: Float) -> FloatBitmap {
  var out = b
  for y in 0..<b.height {
    for x in 0..<b.width {
      for c in 0..<4 {
        var sum: Float = 0
        for dy in -1...1 {
          for dx in -1...1 {
            let xx = min(max(x + dx, 0), b.width - 1), yy = min(max(y + dy, 0), b.height - 1)
            sum += b.px[(yy * b.width + xx) * 4 + c]
          }
        }
        let i = (y * b.width + x) * 4 + c
        out.px[i] = max(0, min(1, b.px[i] + amount * (b.px[i] - sum / 9)))
      }
    }
  }
  return out
}

func context(_ w: Int, _ h: Int) -> CGContext {
  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.interpolationQuality = .high
  return ctx
}

var floatCache: [ObjectIdentifier: FloatBitmap] = [:]

/// `image` at `side`: area-averaged, then sharpened the more the smaller it is (toolbar
/// sizes most; nothing from 64 up, where averaging alone stays crisp).
func scaled(_ image: CGImage, _ side: Int) -> CGImage {
  let key = ObjectIdentifier(image)
  let source = floatCache[key] ?? floats(image)
  floatCache[key] = source
  let small = areaAverage(source, side, side)
  let amount: Float = side <= 32 ? 0.6 : side <= 48 ? 0.35 : 0
  return cgImage(amount > 0 ? sharpen(small, amount) : small)
}

/// `image` drawn `art` px wide in the middle of a transparent `side` canvas.
func padded(_ image: CGImage, side: Int, art: Int) -> CGImage {
  let ctx = context(side, side)
  let inset = CGFloat(side - art) / 2
  ctx.draw(scaled(image, art), in: CGRect(x: inset, y: inset, width: CGFloat(art), height: CGFloat(art)))
  return ctx.makeImage()!
}

/// A promo tile: the logo on a dark purple gradient (the TV's own colours).
func tile(_ logo: CGImage, width: Int, height: Int) -> CGImage {
  let ctx = context(width, height)
  let colors = [CGColor(red: 0.16, green: 0.02, blue: 0.27, alpha: 1), CGColor(red: 0.02, green: 0.0, blue: 0.06, alpha: 1)] as CFArray
  let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: colors, locations: [0, 1])!
  let center = CGPoint(x: CGFloat(width) / 2, y: CGFloat(height) / 2)
  ctx.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center,
                         endRadius: CGFloat(max(width, height)) * 0.6, options: [.drawsAfterEndLocation])
  let art = Int(Double(height) * 0.78)
  let x = (width - art) / 2, y = (height - art) / 2
  ctx.draw(scaled(logo, art), in: CGRect(x: x, y: y, width: art, height: art))
  return ctx.makeImage()!
}

let root = FileManager.default.currentDirectoryPath
guard FileManager.default.fileExists(atPath: "\(root)/brand/source") else { fail("run this from the repo root") }

print("Cutting out the artwork:")
var art: [String: CGImage] = [:]
for name in ["wtv-logo", "wtv-play", "wtv-static"] {
  var bitmap = load("brand/source/\(name).png")
  cutOut(&bitmap)
  let image = cgImage(cropSquare(bitmap))
  save(image, "brand/\(name).png")
  art[name] = image
}

// What goes where. The logo's lettering turns to mush under 48 px, so the toolbar and the
// small sizes (tab icons of Wtv's pages) get the play TV. Chrome wants 96 px of artwork in
// the 128 px icon (16 px transparent each side); Edge wants a 300 px logo.
let logo = art["wtv-logo"]!, play = art["wtv-play"]!

print("Icons:")
for side in [16, 24, 32] { save(scaled(play, side), "public/icon/\(side).png") }
save(scaled(logo, 48), "public/icon/48.png")
save(padded(logo, side: 128, art: 96), "public/icon/128.png")
save(scaled(logo, 96), "public/wtv-logo-96.png")   // the popup header (48 px, sharp on 2× screens)
save(scaled(logo, 256), "public/wtv-logo.png")

print("Store images:")
save(padded(logo, side: 128, art: 96), "brand/store/chrome-store-icon-128.png")
save(scaled(logo, 300), "brand/store/edge-logo-300.png")
save(tile(logo, width: 440, height: 280), "brand/store/promo-small-440x280.png")
save(tile(logo, width: 1400, height: 560), "brand/store/promo-marquee-1400x560.png")
