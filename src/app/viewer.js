import * as Cesium from 'cesium';
import { applyModelAtmosphereWorkaround } from './atmosphereCompat.js';

const PINCH_ZOOM_MULTIPLIER = 8;
const MAX_PINCH_PIXEL_DELTA = 120;

function boundedPinchDelta(delta) {
  if (!Number.isFinite(delta) || delta === 0) return delta;
  return (
    Math.sign(delta) *
    Math.min(Math.abs(delta) * PINCH_ZOOM_MULTIPLIER, MAX_PINCH_PIXEL_DELTA)
  );
}

/**
 * Add browser trackpad pinch to Cesium's zoom inputs and return its disposer.
 * Browsers expose this gesture as a small pixel-mode Ctrl+wheel event.
 */
export function installTrackpadPinchZoom(
  viewer,
  { createWheelEvent = (type, init) => new WheelEvent(type, init) } = {},
) {
  const controller = viewer?.scene?.screenSpaceCameraController;
  const container = viewer?.container;
  const canvas = viewer?.canvas;
  if (!controller || !container || !canvas)
    throw new TypeError('A complete Cesium viewer is required');

  const originalZoomEventTypes = controller.zoomEventTypes;
  const zoomEventTypes = Array.isArray(originalZoomEventTypes)
    ? originalZoomEventTypes
    : originalZoomEventTypes === undefined
      ? []
      : [originalZoomEventTypes];
  const alreadyHandlesControlWheel = zoomEventTypes.some(
    (binding) =>
      binding?.eventType === Cesium.CameraEventType.WHEEL &&
      binding?.modifier === Cesium.KeyboardEventModifier.CTRL,
  );
  const configuredZoomEventTypes = alreadyHandlesControlWheel
    ? originalZoomEventTypes
    : [
        ...zoomEventTypes,
        {
          eventType: Cesium.CameraEventType.WHEEL,
          modifier: Cesium.KeyboardEventModifier.CTRL,
        },
      ];
  if (!alreadyHandlesControlWheel)
    controller.zoomEventTypes = configuredZoomEventTypes;

  const relayedEvents = new WeakSet();
  const relayPinch = (event) => {
    if (
      !event.ctrlKey ||
      relayedEvents.has(event) ||
      event.deltaMode !== 0 ||
      !Number.isFinite(event.deltaY) ||
      event.deltaY === 0
    )
      return;
    let relayed;
    try {
      relayed = createWheelEvent('wheel', {
        deltaX: event.deltaX,
        deltaY: boundedPinchDelta(event.deltaY),
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
        screenX: event.screenX,
        screenY: event.screenY,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
        view: globalThis.window,
      });
    } catch {
      // The registered Ctrl+wheel binding can still consume the original.
      return;
    }
    relayedEvents.add(relayed);
    event.preventDefault();
    event.stopPropagation();
    canvas.dispatchEvent(relayed);
  };
  container.addEventListener('wheel', relayPinch, {
    capture: true,
    passive: false,
  });

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    container.removeEventListener('wheel', relayPinch, true);
    if (
      !alreadyHandlesControlWheel &&
      controller.zoomEventTypes === configuredZoomEventTypes
    )
      controller.zoomEventTypes = originalZoomEventTypes;
  };
}

/**
 * Clamp viewer.resolutionScale so that the canvas dimensions never exceed the
 * GPU's maximum texture size, preventing GlobeDepth and framebuffer texture
 * allocation DeveloperErrors on 2K/4K and fullscreen displays (#905).
 */
export function clampResolutionToTextureLimits(viewer, targetScale = 1.0) {
  const maxTextureSize =
    viewer?.scene?.context?.maximumTextureSize ??
    Cesium?.ContextLimits?.maximumTextureSize ??
    0;
  if (!maxTextureSize || maxTextureSize <= 0) return;

  const canvas = viewer?.canvas;
  const width =
    canvas?.clientWidth ||
    (typeof window !== 'undefined' ? window.innerWidth : 0);
  const height =
    canvas?.clientHeight ||
    (typeof window !== 'undefined' ? window.innerHeight : 0);
  const maxDim = Math.max(width, height);
  if (maxDim <= 0) return;

  const maxAllowedScale = maxTextureSize / maxDim;
  if (maxAllowedScale < targetScale) {
    viewer.resolutionScale = maxAllowedScale;
  } else if (viewer.resolutionScale < targetScale) {
    viewer.resolutionScale = Math.min(targetScale, maxAllowedScale);
  }
}

/**
 * Install a resize and fullscreen listener that continuously guarantees the
 * drawing buffer fits within the GPU's texture size limit. Returns a disposer.
 */
export function installTextureLimitGuard(
  viewer,
  { targetScale = 1.0, windowTarget = globalThis.window } = {},
) {
  if (!windowTarget?.addEventListener) return () => {};
  const enforce = () => clampResolutionToTextureLimits(viewer, targetScale);
  enforce();
  windowTarget.addEventListener('resize', enforce);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    windowTarget.removeEventListener('resize', enforce);
  };
}

/** Create the standard globe viewer in caller-owned, visible containers. */
export function createApplicationViewer({ container, creditContainer }) {
  if (!container || !creditContainer)
    throw new TypeError('Viewer and credit containers are required');
  const viewer = new Cesium.Viewer(container, {
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    vrButton: false,
    selectionIndicator: false,
    infoBox: false,
    baseLayer: false,
    creditContainer,
    msaaSamples: 4,
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
  });
  try {
    viewer.targetFrameRate = 60;
    // Before any tile builds a draw command: Cesium's per-vertex model
    // atmosphere fails to LINK on Apple's Metal backend and kills the
    // render loop. See app/atmosphereCompat.js.
    applyModelAtmosphereWorkaround(viewer.scene);
    viewer.scene.globe.show = false;
    viewer.scene.skyAtmosphere.show = true;
    viewer.scene.skyAtmosphere.atmosphereLightIntensity = 18;
    viewer.scene.skyAtmosphere.saturationShift = -0.12;
    viewer.scene.skyAtmosphere.brightnessShift = -0.08;

    const uninstallGuard = installTextureLimitGuard(viewer);
    const originalDestroy = viewer.destroy.bind(viewer);
    viewer.destroy = () => {
      uninstallGuard();
      return originalDestroy();
    };

    return viewer;
  } catch (error) {
    viewer.destroy();
    throw error;
  }
}
