// OCR a set of frames with macOS Vision, returning text WITH bounding boxes.
//
// WHY BOXES MATTER: a reel carries two kinds of on-screen text — the burned-in TITLE
// (persistent, stable wording, usually one position) and rolling CAPTIONS (same position,
// text changes every second). Telling them apart is what we actually need, and the only
// mechanical way is to track each text's position across frames and ask which one stays
// the same. A vision LLM returns prose with no coordinates and merges the two.
//
// Vision is also free, offline, and markedly better than tesseract on outlined bold text
// over video.
//
// Usage: FrameOCR <frame.jpg> [frame.jpg ...]   → JSON array on stdout

import Foundation
import Vision
import CoreImage

struct Box: Encodable {
    let text: String
    let confidence: Float
    let x: Double, y: Double, w: Double, h: Double   // normalised, origin top-left
}
struct FrameResult: Encodable {
    let frame: String
    let observations: [Box]
}

func ocr(_ path: String) -> FrameResult {
    guard let img = CIImage(contentsOf: URL(fileURLWithPath: path)) else {
        return FrameResult(frame: path, observations: [])
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["en-US"]

    let handler = VNImageRequestHandler(ciImage: img, options: [:])
    do { try handler.perform([request]) } catch { return FrameResult(frame: path, observations: []) }

    var out: [Box] = []
    for obs in (request.results ?? []) {
        guard let top = obs.topCandidates(1).first else { continue }
        let bb = obs.boundingBox    // Vision origin is bottom-left; flip to top-left.
        out.append(Box(
            text: top.string,
            confidence: top.confidence,
            x: Double(bb.minX),
            y: Double(1.0 - bb.maxY),
            w: Double(bb.width),
            h: Double(bb.height)
        ))
    }
    return FrameResult(frame: path, observations: out)
}

let frames = Array(CommandLine.arguments.dropFirst())
let results = frames.map(ocr)
let data = try! JSONEncoder().encode(results)
FileHandle.standardOutput.write(data)
