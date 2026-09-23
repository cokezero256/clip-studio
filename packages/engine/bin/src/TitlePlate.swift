// Renders a title plate — rounded box + text — to a transparent PNG.
//
// WHY THIS EXISTS: the title is drawn in ASS today, and libass cannot render Apple Color
// Emoji. Every reference reel's title carries one (🤯 😭 😳 ✅) and they came out as tofu
// boxes. CoreText handles emoji natively, and as a bonus it gives EXACT text metrics
// instead of the 0.6-char-width estimate the ASS path has to guess with — which is also
// what makes a click-and-drag title editor possible later.
//
// Reads a JSON spec on stdin, writes a PNG, prints the measured geometry as JSON.

import Foundation
import CoreText
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

struct Spec: Decodable {
    var text: String
    var out: String
    var fontName: String?
    var fontSize: Double?
    var textColor: String?
    var fill: String?
    var radius: Double?
    var padX: Double?
    var padY: Double?
    var maxWidth: Double?
    var scale: Double?
    var lineSpacing: Double?
    // Font files to register before resolving fontName. Without this the plate could only use
    // fonts installed in macOS, so the same spec rendered differently on another machine and
    // the editor's font list could not be trusted.
    var fontFiles: [String]?
    // Outline, as a percentage of the font size (e.g. 8). For box-off titles over video.
    var strokeColor: String?
    var strokeWidth: Double?
    // Soft drop shadow under the text.
    var shadowColor: String?
    var shadowBlur: Double?
    var shadowOffsetY: Double?
}

func hexColor(_ hex: String?, fallback: CGColor) -> CGColor {
    guard var h = hex else { return fallback }
    if h.hasPrefix("#") { h.removeFirst() }
    guard h.count == 6 || h.count == 8, let v = UInt32(h, radix: 16) else { return fallback }
    let hasAlpha = h.count == 8
    let r = Double((v >> (hasAlpha ? 24 : 16)) & 0xFF) / 255.0
    let g = Double((v >> (hasAlpha ? 16 : 8)) & 0xFF) / 255.0
    let b = Double((v >> (hasAlpha ? 8 : 0)) & 0xFF) / 255.0
    let a = hasAlpha ? Double(v & 0xFF) / 255.0 : 1.0
    return CGColor(red: r, green: g, blue: b, alpha: a)
}

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let spec = try? JSONDecoder().decode(Spec.self, from: data) else {
    FileHandle.standardError.write("TitlePlate: could not parse spec JSON\n".data(using: .utf8)!)
    exit(2)
}

let scale    = spec.scale ?? 1.0
let fontSize = (spec.fontSize ?? 62) * scale
let padX     = (spec.padX ?? fontSize * 0.55) * 1.0
let padY     = (spec.padY ?? fontSize * 0.34) * 1.0
let radius   = (spec.radius ?? fontSize * 0.32) * 1.0
let maxWidth = (spec.maxWidth ?? 1080) * scale

for f in spec.fontFiles ?? [] {
    CTFontManagerRegisterFontsForURL(URL(fileURLWithPath: f) as CFURL, .process, nil)
}

// Resolve the font by full name (e.g. "Sequel Sans Bold Head"); fall back to a system bold.
let baseFont: CTFont = {
    if let n = spec.fontName, !n.isEmpty {
        let f = CTFontCreateWithName(n as CFString, fontSize, nil)
        // CTFontCreateWithName silently substitutes; check we got something close.
        let got = (CTFontCopyFullName(f) as String).lowercased()
        if got.contains(n.lowercased().prefix(6)) { return f }
    }
    return CTFontCreateUIFontForLanguage(.emphasizedSystem, fontSize, nil)
        ?? CTFontCreateWithName("HelveticaNeue-Bold" as CFString, fontSize, nil)
}()

let textColor = hexColor(spec.textColor, fallback: CGColor(red: 0, green: 0, blue: 0, alpha: 1))
let fillColor = hexColor(spec.fill, fallback: CGColor(red: 1, green: 1, blue: 1, alpha: 1))

// CoreText's own paragraph style — avoids pulling in AppKit just for centring.
var alignment = CTTextAlignment.center
var lineSpacing = CGFloat((spec.lineSpacing ?? 0) * scale)
let settings: [CTParagraphStyleSetting] = withUnsafeBytes(of: &alignment) { aBuf in
    withUnsafeBytes(of: &lineSpacing) { lBuf in
        [
            CTParagraphStyleSetting(spec: .alignment,
                                    valueSize: MemoryLayout<CTTextAlignment>.size,
                                    value: aBuf.baseAddress!),
            CTParagraphStyleSetting(spec: .lineSpacingAdjustment,
                                    valueSize: MemoryLayout<CGFloat>.size,
                                    value: lBuf.baseAddress!),
        ]
    }
}
let para = CTParagraphStyleCreate(settings, settings.count)

let attrs: [CFString: Any] = [
    kCTFontAttributeName: baseFont,
    kCTForegroundColorAttributeName: textColor,
    kCTParagraphStyleAttributeName: para,
]
// The outline is drawn as a SEPARATE pass underneath the fill. A single stroke-and-fill pass
// centres the stroke on the glyph edge, so its inner half eats into the letters: measured on
// a white title with a black outline, strokes came out visibly thin and "$" read as "S".
// Stroking alone first (at double width — half of it ends up hidden under the fill) and then
// filling on top leaves the outline strictly outside the letterforms.
let outlineAttrs: [CFString: Any]? = {
    guard let sw = spec.strokeWidth, sw > 0 else { return nil }
    var a = attrs
    a[kCTStrokeWidthAttributeName] = sw * 2
    a[kCTStrokeColorAttributeName] = hexColor(spec.strokeColor, fallback: CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    return a
}()
let attributed = CFAttributedStringCreate(nil, spec.text as CFString, attrs as CFDictionary)!

// Lay out inside the available text width so CoreText does the line breaking — including
// around emoji, which the naive character-count estimate cannot do.
let textMax = max(40, maxWidth - padX * 2)
let framesetter = CTFramesetterCreateWithAttributedString(attributed)
var fitRange = CFRange()
let suggested = CTFramesetterSuggestFrameSizeWithConstraints(
    framesetter, CFRange(location: 0, length: 0), nil,
    CGSize(width: textMax, height: .greatestFiniteMagnitude), &fitRange)

let strokePad = CGFloat((spec.strokeWidth ?? 0) / 100.0) * CGFloat(fontSize)
let shadowPad = CGFloat((spec.shadowBlur ?? 0) + abs(spec.shadowOffsetY ?? 0)) * CGFloat(scale)
let extra = ceil(strokePad + shadowPad)
let textW = ceil(suggested.width) + extra * 2
let textH = ceil(suggested.height) + extra * 2
let boxW  = ceil(textW + padX * 2)
let boxH  = ceil(textH + padY * 2)

guard let ctx = CGContext(data: nil, width: Int(boxW), height: Int(boxH),
                          bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpaceCreateDeviceRGB(),
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    FileHandle.standardError.write("TitlePlate: could not create bitmap context\n".data(using: .utf8)!)
    exit(3)
}
ctx.clear(CGRect(x: 0, y: 0, width: boxW, height: boxH))

// Rounded plate.
let plate = CGPath(roundedRect: CGRect(x: 0, y: 0, width: boxW, height: boxH),
                   cornerWidth: radius, cornerHeight: radius, transform: nil)
ctx.addPath(plate)
ctx.setFillColor(fillColor)
ctx.fillPath()

if let sc = spec.shadowColor, (spec.shadowBlur ?? 0) > 0 {
    ctx.setShadow(offset: CGSize(width: 0, height: -CGFloat((spec.shadowOffsetY ?? 0) * scale)),
                  blur: CGFloat((spec.shadowBlur ?? 0) * scale),
                  color: hexColor(sc, fallback: CGColor(red: 0, green: 0, blue: 0, alpha: 0.6)))
}

// Text, vertically centred inside the plate.
let textRect = CGRect(x: padX + extra, y: padY + extra, width: textW - extra * 2, height: textH - extra * 2)
if let oa = outlineAttrs {
    let outlined = CFAttributedStringCreate(nil, spec.text as CFString, oa as CFDictionary)!
    let ofs = CTFramesetterCreateWithAttributedString(outlined)
    let oframe = CTFramesetterCreateFrame(ofs, CFRange(location: 0, length: 0),
                                          CGPath(rect: textRect, transform: nil), nil)
    CTFrameDraw(oframe, ctx)
    // The shadow belongs to the outline pass only; the fill on top must not cast a second one.
    ctx.setShadow(offset: .zero, blur: 0, color: nil)
}
let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: 0, length: 0),
                                     CGPath(rect: textRect, transform: nil), nil)
CTFrameDraw(frame, ctx)

guard let image = ctx.makeImage() else { exit(4) }
let url = URL(fileURLWithPath: spec.out) as CFURL
guard let dest = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else { exit(5) }
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { exit(6) }

// Report geometry so the caller can position the overlay exactly.
let out: [String: Any] = [
    "width": Int(boxW), "height": Int(boxH),
    "textWidth": Int(textW), "textHeight": Int(textH),
    "fontSize": fontSize, "scale": scale,
    "font": CTFontCopyFullName(baseFont) as String,
]
let json = try! JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(json)
