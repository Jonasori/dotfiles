// screenshot-ocr — extract text from a macOS screenshot/image via Vision.
//
// Usage:
//   swift ocr.swift "<path-or-fragment>"
//
// Accepts an exact file path OR a substring fragment of the filename.
// When given a fragment, it searches the Desktop and current directory.
// Handles the non-ASCII narrow no-break space (U+202F) that macOS inserts
// in screenshot filenames before AM/PM — never type those paths by hand.
import Vision
import AppKit
import Foundation

guard CommandLine.arguments.count >= 2 else {
    print("usage: swift ocr.swift <path-or-fragment>")
    exit(2)
}
let input = CommandLine.arguments[1]

func resolvePath(_ candidate: String) -> String? {
    if FileManager.default.fileExists(atPath: candidate) { return candidate }
    // Exact path failed (likely non-ASCII). Try fragment search.
    let dirs = [NSHomeDirectory() + "/Desktop", FileManager.default.currentDirectoryPath]
    for dir in dirs {
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(atPath: dir) else { continue }
        for item in items where item.contains(candidate) {
            return (dir as NSString).appendingPathComponent(item)
        }
    }
    return nil
}

guard let path = resolvePath(input.trimmingCharacters(in: .whitespaces)) else {
    print("cannot find file matching: \(input)")
    exit(1)
}

guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("cannot load image: \(path)")
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([request])
} catch {
    print("OCR failed: \(error.localizedDescription)")
    exit(1)
}

for observation in request.results ?? [] {
    if let candidate = observation.topCandidates(1).first {
        print(candidate.string)
    }
}
// Exit 0 even with zero recognized text; the caller can retry with sips.
