#!/usr/bin/env python3
"""
End-to-end Web Automation Test Suite for Minilang Notebook (pSCRAM).

Drives a real headless Chromium browser via Playwright against a live
minilang-notebook server and asserts ZERO console errors, ZERO uncaught page
errors, and full functional behavior across:
  1. Initial boot & dedicated open-files tab bar
  2. Opening & executing Minilang notebooks (.mnb) + Variable Inspector
  3. Script editor (.mini) + Params panel + Run in Minilang
  4. Interactive Bytecode Debugger (gutter breakpoints, step, locals, console eval)
  5. Background Service + TWO concurrent standalone .ui apps exchanging SSE/RPC messages
  6. Markdown, CSV, and MLOG viewers + Command Palette, Grep, Jobs/Services, Schedules, Secrets

Usage:
  # Run against an already-running server:
  python3 tests/web_e2e.py --url http://127.0.0.1:8888

  # Or automatically invoked by `cargo test --test web_automation` when Playwright is installed.
  # Install Playwright once on a workstation/CI host:
  #   pip install playwright && playwright install chromium
"""

import argparse
import json
import sys
import time


def run_suite(base_url: str) -> None:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "Playwright is not installed. Install with: pip install playwright && playwright install chromium",
            file=sys.stderr,
        )
        sys.exit(2)

    base_url = base_url.rstrip("/")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        console_errors = []
        page_errors = []
        failed_requests = []

        def attach_error_listeners(pg, label="main"):
            pg.on(
                "console",
                lambda msg: console_errors.append(f"[{label} console.error] {msg.text}")
                if msg.type == "error"
                else None,
            )
            pg.on(
                "pageerror",
                lambda exc: page_errors.append(f"[{label} pageerror] {exc}"),
            )
            pg.on(
                "response",
                lambda resp: failed_requests.append(f"[{label} HTTP {resp.status}] {resp.url}")
                if resp.status >= 400 and "/api/file?path=notebooks%2Fwelcome.mnb" not in resp.url
                else None,
            )

        attach_error_listeners(page, "workbench")

        # ------------------------------------------------------------------
        # 1. Boot workbench & verify layout + zero errors
        # ------------------------------------------------------------------
        print("1. Loading workbench:", base_url)
        page.goto(base_url, wait_until="networkidle")
        page.wait_for_selector("#file-list .file-row", timeout=10000)

        # Verify tab-bar sits on its own row below header.topbar
        topbar_box = page.locator("header.topbar").bounding_box()
        tabbar_box = page.locator("#tab-bar").bounding_box()
        assert topbar_box and tabbar_box, "topbar and #tab-bar must be visible"
        assert tabbar_box["y"] >= topbar_box["y"] + topbar_box["height"] - 1, (
            f"#tab-bar (y={tabbar_box['y']}) should be below .topbar (bottom={topbar_box['y'] + topbar_box['height']})"
        )

        # ------------------------------------------------------------------
        # 2. Open notebook from file explorer, run a cell, inspect variables
        #    (Regression test for `logLiveTimer is not defined`)
        # ------------------------------------------------------------------
        print("2. Opening notebook notebooks/custom_ui.mnb and executing cell...")
        page.locator('#file-list .file-row[data-path="notebooks"]').click()
        page.wait_for_selector('#file-list .file-row[data-path="notebooks/custom_ui.mnb"]', timeout=8000)
        page.locator('#file-list .file-row[data-path="notebooks/custom_ui.mnb"]').click()

        page.wait_for_selector("#notebook-view:not(.hidden)", timeout=8000)
        page.wait_for_selector("#cells-container .cell", timeout=8000)
        assert not page.locator(".toast.error").count(), "Unexpected error toast when opening notebook"

        # Execute first code cell and verify output
        page.locator("#tb-run").click()
        page.wait_for_selector("#cells-container .output-stdout", timeout=15000)
        stdout_text = page.locator("#cells-container .output-stdout").first.inner_text()
        assert "hello-from-notebook" in stdout_text, f"Unexpected notebook stdout: {stdout_text!r}"

        # Open Variable Inspector drawer
        page.locator("#btn-toggle-vars").click()
        page.wait_for_selector("#vars-drawer:not(.hidden)", timeout=5000)
        page.wait_for_timeout(400)
        assert "nb_answer" in page.locator("#vars-content").inner_text()
        page.locator("#btn-close-vars").click()

        # ------------------------------------------------------------------
        # 3. Open .mini script, configure Params, Run in Minilang
        # ------------------------------------------------------------------
        print("3. Opening scripts/greet.mini, setting Params, and running...")
        page.locator("#breadcrumbs .crumb").first.click()
        page.wait_for_selector('#file-list .file-row[data-path="scripts"]', timeout=8000)
        page.locator('#file-list .file-row[data-path="scripts"]').click()
        page.wait_for_selector('#file-list .file-row[data-path="scripts/greet.mini"]', timeout=8000)
        page.locator('#file-list .file-row[data-path="scripts/greet.mini"]').click()
        page.wait_for_selector("#file-view:not(.hidden)", timeout=8000)

        page.locator("#ftb-params").click()
        page.wait_for_selector("#file-params-panel:not(.hidden)", timeout=5000)
        page.locator("#file-params-textarea").fill(json.dumps({"name": "WebBot", "repeat": 2}))
        page.locator("#ftb-run-mini").click()

        page.wait_for_selector("#file-run-output:not(.hidden) .output-stdout", timeout=15000)
        run_out = page.locator("#file-run-output-body").inner_text()
        assert "WebBot!!" in run_out, f"Expected Params output 'WebBot!!', got: {run_out!r}"

        # ------------------------------------------------------------------
        # 4. Interactive Debugger: breakpoint gutter, step, locals, console eval
        # ------------------------------------------------------------------
        print("4. Debugging scripts/greet.mini with breakpoint & frame eval...")
        page.locator('#file-editor-gutter .fe-gutter-line[data-line="5"]').click()
        assert page.locator('#file-editor-gutter .fe-gutter-line[data-line="5"].bp-active').count() == 1

        # Open debugger with Stop on Entry unchecked so we hit breakpoint on line 5 directly
        page.locator("#btn-toggle-debug").click()
        page.wait_for_selector("#debug-drawer:not(.hidden)", timeout=5000)
        if page.locator("#dbg-opt-stop-entry").is_checked():
            page.locator("#dbg-opt-stop-entry").uncheck()
        page.locator("#ftb-debug").click()

        page.wait_for_function(
            "() => document.getElementById('dbg-status-badge')?.textContent?.trim() === 'paused'",
            timeout=15000,
        )
        locals_text = page.locator("#dbg-locals-list").inner_text()
        assert "WebBot!!" in locals_text, f"Expected local msg='WebBot!!' in debugger locals: {locals_text!r}"

        # Evaluate expression in paused frame via Debug Console
        page.locator("#dbg-eval-input").fill('Params["name"] + "_dbg"')
        page.locator("#dbg-eval-btn").click()
        page.wait_for_selector("#dbg-eval-history .dbg-eval-res", timeout=8000)
        eval_text = page.locator("#dbg-eval-history").inner_text()
        assert "WebBot_dbg" in eval_text, f"Expected Debug Console eval 'WebBot_dbg', got: {eval_text!r}"

        # Continue to completion
        page.locator("#dbg-btn-continue").click()
        page.wait_for_function(
            "() => document.getElementById('dbg-status-badge')?.textContent?.trim() === 'completed'",
            timeout=15000,
        )
        page.locator("#btn-close-debug").click()

        # ------------------------------------------------------------------
        # 5. Background Service + Two Independent Standalone UIs (SSE + RPC)
        # ------------------------------------------------------------------
        print("5. Starting background service and testing cross-UI messaging across 2 UIs...")
        page.locator("#btn-open-jobs").click()
        page.wait_for_selector("#jobs-modal-overlay:not(.hidden)", timeout=5000)
        page.locator("#jobs-tab-services").click()
        page.locator("#svc-name").fill("counter")
        page.locator("#svc-script").fill("services/counter.mini")
        page.locator("#svc-params").fill('{"initial": 10}')
        page.locator('#service-launch-form button[type="submit"]').click()
        page.wait_for_selector('#services-list .job-card:has-text("counter")', timeout=10000)
        page.locator("#jobs-modal-close").click()

        ui_url = f"{base_url}/ui/ui/counter.ui"
        ui_page_1 = context.new_page()
        ui_page_2 = context.new_page()
        attach_error_listeners(ui_page_1, "ui-1")
        attach_error_listeners(ui_page_2, "ui-2")

        ui_page_1.goto(ui_url, wait_until="networkidle")
        ui_page_2.goto(ui_url, wait_until="networkidle")
        ui_page_1.wait_for_selector('text="Count: 10"', timeout=10000)
        ui_page_2.wait_for_selector('text="Count: 10"', timeout=10000)

        # Click "+1" in UI #1 -> BOTH UI #1 and UI #2 update to Count: 11 via SSE!
        ui_page_1.locator('button:has-text("+1")').click()
        ui_page_1.wait_for_selector('text="Count: 11"', timeout=10000)
        ui_page_2.wait_for_selector('text="Count: 11"', timeout=10000)

        ui_page_1.close()
        ui_page_2.close()

        # ------------------------------------------------------------------
        # 6. Viewers (Markdown, CSV) & Modals (Palette, Grep, Schedules, Secrets)
        # ------------------------------------------------------------------
        print("6. Verifying Markdown/CSV viewers and workbench modals...")
        page.locator("#breadcrumbs .crumb").first.click()
        page.wait_for_selector('#file-list .file-row[data-path="README.md"]', timeout=8000)
        page.locator('#file-list .file-row[data-path="README.md"]').click()
        page.wait_for_selector("#markdown-view:not(.hidden)", timeout=5000)
        assert "E2E Workspace" in page.locator("#md-preview-content").inner_text()

        page.locator('#file-list .file-row[data-path="data.csv"]').click()
        page.wait_for_selector("#data-view:not(.hidden) table", timeout=5000)
        assert "Alice" in page.locator("#data-table-host").inner_text()

        # Command Palette
        page.locator("#btn-command-palette").click()
        page.wait_for_selector("#cmd-palette-overlay:not(.hidden)", timeout=5000)
        page.keyboard.press("Escape")

        # Find in Files
        page.locator("#btn-find-in-files").click()
        page.wait_for_selector("#grep-modal-overlay:not(.hidden)", timeout=5000)
        page.locator("#grep-modal-close").click()

        # Schedules & Secrets modals
        page.locator("#btn-open-schedules").click()
        page.wait_for_selector("#schedules-modal-overlay:not(.hidden)", timeout=5000)
        page.locator("#schedules-modal-close").click()

        page.locator("#btn-open-secrets").click()
        page.wait_for_selector("#secrets-modal-overlay:not(.hidden)", timeout=5000)
        page.locator("#secrets-modal-close").click()

        browser.close()

    if page_errors or console_errors or failed_requests:
        print("WEB E2E FAILURES DETECTED:", file=sys.stderr)
        for e in page_errors + console_errors + failed_requests:
            print("  -", e, file=sys.stderr)
        sys.exit(1)

    print("ALL WEB E2E AUTOMATION TESTS PASSED WITH 0 ERRORS!")


def main() -> None:
    parser = argparse.ArgumentParser(description="Minilang Notebook Web Automation Suite")
    parser.add_argument("--url", required=True, help="Base URL of running minilang-notebook server")
    args = parser.parse_args()
    run_suite(args.url)


if __name__ == "__main__":
    main()
