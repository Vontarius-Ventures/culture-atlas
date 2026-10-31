import XCTest

/// Camera UI coverage. The live phone test reaches Take photo and Keep;
/// server upload/commit qualification needs separate persisted-asset evidence.
final class CameraKeepTests: XCTestCase {
  /// Exercise the real camera entry and unavailable UI after a test-owned
  /// session passes the real onboarding gate. No synthetic camera output.
  func testFixtureSimulatorCameraOffersPhotosWithoutCaptureControls() throws {
    #if targetEnvironment(simulator)
    let app = XCUIApplication()
    app.launchArguments = ["-AtlasNativeUITestFixture"]
    app.launch()
    let captureTab = app.tabBars.buttons["Capture"]
    XCTAssertTrue(captureTab.waitForExistence(timeout: 15))
    captureTab.tap()
    let thisCamera = app.descendants(matching: .any)["capture.this-camera"]
    XCTAssertTrue(thisCamera.waitForExistence(timeout: 10))
    thisCamera.tap()

    let permissionMonitor = addUIInterruptionMonitor(withDescription: "Camera permission") { alert in
      for title in ["Allow", "OK"] where alert.buttons[title].exists {
        alert.buttons[title].tap()
        return true
      }
      return false
    }
    defer { removeUIInterruptionMonitor(permissionMonitor) }
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap()
    XCTAssertTrue(app.buttons["camera.choose-photos"].waitForExistence(timeout: 15))
    XCTAssertTrue(
      app.staticTexts["No camera here"].exists || app.staticTexts["Camera access is off"].exists,
      "Unavailable camera must explain hardware or permission state")
    XCTAssertFalse(app.buttons["capture.take-photo"].exists)
    XCTAssertFalse(app.buttons["capture.keep"].exists)
    #else
    throw XCTSkip("The isolated no-camera fixture is simulator-only")
    #endif
  }
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
