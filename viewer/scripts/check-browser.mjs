#!/usr/bin/env node
/** Browser acceptance against built pages. Requires an existing Playwright install and local Chrome. */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { demoBundle } from '../fixtures/demo.mjs'
const require = createRequire(import.meta.url), { chromium } = require(process.env.MARS_VIEWER_PLAYWRIGHT ?? 'playwright')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), artifacts = join(root, 'artifacts')
mkdirSync(artifacts, { recursive: true }); mkdirSync(join(root, '.work'), { recursive: true })
const temporary = mkdtempSync(join(root, '.work', 'ui-')), fixtureFile = join(temporary, 'fixture.json'), badFile = join(temporary, 'invalid.json')
writeFileSync(fixtureFile, JSON.stringify(demoBundle())); writeFileSync(badFile, JSON.stringify({ version: 'bad', source: 'experiment', runs: [] }))
const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')), packetPath = resolve(root, config.defaultData), packet = JSON.parse(readFileSync(packetPath, 'utf8')), run = packet.runs[0]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, offline: true }), page = await context.newPage()
  const errors = [], remoteRequests = [], visited = []
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()) })
  await page.goto(pathToFileURL(join(root, 'dist', 'index.html')).href)
  await page.waitForFunction(() => Boolean(window.marsViewer)); await page.evaluate(() => document.fonts.ready)
  const state = () => page.evaluate(() => window.marsViewer.inspect())
  assert.equal((await state()).source, 'experiment'); assert.equal((await state()).tick, run.tick)
  assert.equal(await page.locator('[data-device]').count(), run.layout.anchors.length)
  assert.equal(await page.locator('[data-crop]').count(), run.snapshot.crops.length)
  assert.equal(await page.locator('.phase-options').count(), 0)
  await page.screenshot({ path: join(artifacts, 'single-terminal.png'), animations: 'disabled' })
  await page.mouse.move(720, 450)
  for (let i = 0; i < 5; i++) {
    const previous = (await state()).camera.width; await page.mouse.wheel(0, 100)
    await page.waitForFunction(width => window.marsViewer.inspect().camera.width > width, previous)
  }
  assert((await state()).camera.width > 4000); assert.equal(await page.locator('.region-label').count(), 12)
  await page.locator('.region-label[data-region=preparation]').click(); assert((await state()).camera.width < 2000)
  await page.locator('#reset-camera').click()
  const originalCamera = (await state()).camera
  await page.mouse.move(310, 550); await page.mouse.down(); await page.mouse.move(390, 600, {steps:5}); await page.mouse.up()
  assert.notEqual((await state()).camera.cx, originalCamera.cx); await page.locator('#reset-camera').click()
  for (const key of ['research', 'records', 'team', 'resources', 'compare']) {
    const before = await state(); await page.locator(`.main-nav [data-panel="${key}"]`).click()
    const count = await page.locator('#sheet-tabs [role=tab]').count()
    for (let i = 0; i < count; i++) {
      await page.locator('#sheet-tabs [role=tab]').nth(i).click()
      const text = await page.locator('#sheet-content').innerText()
      assert(text.length > 20); assert(!text.includes('此分类保留原页面入口'))
      visited.push(`${key}:${i}`)
    }
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('page-sheet').open)
    const after = await state(); assert.deepEqual(after.camera, before.camera); assert.equal(after.tick, before.tick)
  }
  await page.locator('.main-nav [data-panel=research]').click(); await page.locator('#sheet-tabs [role=tab]').nth(2).click()
  const rawOptions = await page.locator('#raw-picker option').evaluateAll(nodes => nodes.map(n => n.value))
  for (const id of rawOptions) {
    await page.locator('#raw-picker').selectOption(id)
    if (await page.locator('#band-picker').count()) { await page.locator('#band-picker').selectOption('-1'); assert(await page.locator('.heatmap-wrap svg').count()) }
  }
  await page.locator('#close-sheet').click()
  const op = run.operations.find(o => o.command.action === 'process' && ['liquid-handler', 'centrifuge-1', 'confirm', 'imager', 'screen'].includes(o.deviceId) && o.processingTick != null) ?? run.operations.find(o => ['liquid-handler', 'centrifuge-1', 'confirm', 'imager', 'screen'].includes(o.deviceId) && o.processingTick != null)
  assert(op, 'Expected a recorded laboratory operation')
  await page.locator('.main-nav [data-panel=records]').click(); await page.locator('#record-filter input').fill(op.id); await page.locator('#record-filter button').click()
  await page.locator('[data-action=operation-detail]').first().click(); await page.locator('[data-action=operation]').filter({ hasText: '回看并定位' }).click()
  await page.waitForFunction(() => !document.getElementById('page-sheet').open)
  assert.equal((await state()).selected, op.deviceId); assert.equal((await state()).tick, op.processingTick)
  assert.equal((await state()).devices.find(d => d.id === op.deviceId).healthKnown, false)
  assert((await page.locator('#detail-health').textContent()).includes('未记录') || (await page.locator('#detail-health').textContent()).includes('未完整记录'))
  await page.screenshot({ path: join(artifacts, 'single-operation.png'), animations: 'disabled' })
  await page.locator('#play-history').click(); const t = (await state()).tick
  await page.waitForFunction(t => window.marsViewer.inspect().tick > t, t)
  await page.locator('#pause-view').click(); assert.equal((await state()).paused, true); assert.equal((await state()).playing, false)
  await page.locator('#close-detail').click(); await page.locator('#close-replay').click(); await page.locator('#reset-camera').click()
  const beforeImport = await state()
  await page.locator('#bundle-file').setInputFiles(badFile); await page.waitForFunction(() => !document.getElementById('import-error').hidden)
  assert.equal((await state()).runId, beforeImport.runId); assert.equal((await state()).source, 'experiment')
  await page.locator('#import-error button').click()
  await page.locator('#bundle-file').setInputFiles(fixtureFile); await page.waitForFunction(() => window.marsViewer.inspect().source === 'fixture')
  assert.equal(await page.locator('#world-picker option').count(), 2)
  await page.locator('.main-nav [data-panel=compare]').click(); assert((await page.locator('#sheet-content').innerText()).includes('左 − 右'))
  await page.locator('#close-sheet').click()
  await page.locator('#scene-menu-toggle').click(); const camera = (await state()).camera
  await page.locator('#world-picker').selectOption('fixture-single-v06'); assert.deepEqual((await state()).camera, camera)
  await page.keyboard.press('Escape')
  await page.locator('#bundle-file').setInputFiles(packetPath); await page.waitForFunction(() => window.marsViewer.inspect().source === 'experiment')
  assert.equal(await page.locator('#world-picker option').count(), 1)
  await page.locator('.main-nav [data-panel=resources]').click()
  const plot = page.locator('.chart-hit').first(); if (await plot.count()) {
    const box = await plot.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    assert.equal(await page.locator('.chart-tooltip').first().isVisible(), true)
    assert.equal(await page.locator('.chart-crosshair').first().getAttribute('hidden'), null)
  }
  await page.screenshot({ path: join(artifacts, 'single-resources.png'), animations: 'disabled' })
  await page.locator('#close-sheet').click()
  for (const viewport of [{ width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.reload(); await page.waitForFunction(() => Boolean(window.marsViewer))
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, nav: document.querySelector('.main-nav').getBoundingClientRect().toJSON() }))
    assert.equal(layout.scroll, viewport.width); assert(layout.nav.left >= 0 && layout.nav.right <= viewport.width)
    await page.locator('.main-nav [data-panel=records]').click(); await page.locator('#close-sheet').click()
    if (viewport.width === 390) {
      assert.equal(await page.locator('#labels [data-object="liquid-handler"]').isVisible(), true)
      assert.equal(await page.locator('#labels [data-object="centrifuge-1"]').isVisible(), true)
      await page.screenshot({ path: join(artifacts, 'single-mobile.png'), animations: 'disabled' })
    }
  }
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForFunction(() => document.body.classList.contains('reduced'))
  assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, [])
  const result = { passed: true, runId: run.id, source: 'experiment', operations: run.operations.length, tabs: visited, rawRecords: rawOptions.length, playback: true, atomicImport: true, fixtureAndExperimentSeparated: true, pairedSample: true, worldCameraPreserved: true, chartHover: true, viewports: [1440, 1024, 390], reducedMotion: true, remoteRequests: 0, errors }
  writeFileSync(join(artifacts, 'browser-check.json'), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result))
} finally { await browser.close(); rmSync(temporary, { recursive: true, force: true }) }
