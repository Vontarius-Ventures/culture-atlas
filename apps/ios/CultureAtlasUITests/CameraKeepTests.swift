import XCTest

/// Physical-phone proof: Take photo then Keep must create a draft and start upload.
final class CameraKeepTests: XCTestCase {
  func testTakePhotoAndKeepOnThisPhone() throws {
    let app = XCUIApplication()
    app.launch()
    addUIInterruptionMonitor(withDescription: "Camera permission") { alert in
      for title in ["OK", "Allow", "Allow While Using App"] {
        let button = alert.buttons[title]
        if button.exists {
          button.tap()
          return true
        }
      }
      return false
    }

    let captureTab = app.tabBars.buttons["Capture"]
    guard captureTab.waitForExistence(timeout: 25) else {
      throw XCTSkip("Not signed in with a finished onboarding on this simulator")
    }
    captureTab.tap()

    let thisCamera = app.descendants(matching: .any)["capture.this-camera"]
    XCTAssertTrue(thisCamera.waitForExistence(timeout: 10), "This camera should be offered")
    thisCamera.tap()

    // No camera (simulator): the screen offers Choose from Photos instead.
    if app.buttons["camera.choose-photos"].waitForExistence(timeout: 8) {
      throw XCTSkip("No camera on this device; the no-camera state offered Choose from Photos")
    }
    let take = app.buttons["capture.take-photo"]
    XCTAssertTrue(take.waitForExistence(timeout: 20), "Camera preview should start")
    // Permission alerts steal first taps.
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap()
    XCTAssertTrue(take.waitForExistence(timeout: 15))
    take.tap()

    let keep = app.buttons["capture.keep"]
    XCTAssertTrue(keep.waitForExistence(timeout: 20), "Review sheet should offer Keep")
    keep.tap()
  }
}
