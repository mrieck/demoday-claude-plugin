import Foundation
import CoreGraphics

// Match web actions: positive dy moves down. Quartz wheel deltas use the
// opposite sign. One process posts the entire gesture on a monotonic clock.
guard CommandLine.arguments.count == 3,
      let dy = Int32(CommandLine.arguments[1]),
      let milliseconds = Double(CommandLine.arguments[2]),
      milliseconds.isFinite, milliseconds >= 0 else { exit(2) }
let duration = milliseconds / 1000
let frames = max(1, Int(ceil(duration * 60)))
let start = ProcessInfo.processInfo.systemUptime
var previous = 0
for frame in 1...frames {
    let t = Double(frame) / Double(frames)
    let eased = t * t * (3 - 2 * t)
    let total = Int((Double(dy) * eased).rounded())
    let delta = total - previous
    if delta != 0 {
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                                  wheelCount: 1, wheel1: Int32(-delta), wheel2: 0, wheel3: 0)
        else { exit(3) }
        event.post(tap: .cghidEventTap)
    }
    previous = total
    let wait = start + duration * t - ProcessInfo.processInfo.systemUptime
    if wait > 0 { Thread.sleep(forTimeInterval: wait) }
}
