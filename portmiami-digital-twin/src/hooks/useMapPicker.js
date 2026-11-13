/**
 * The shared pick dispatcher, created once per viewer and handed to every selectable layer.
 *
 * It is a ref rather than state: creating it must not re-render, and the layers that register with
 * it are installed from effects, not from the render pass.
 */
import { useEffect, useRef } from 'react';
import { createMapPicker } from '../cesium/mapPicking.js';

export function useMapPicker(viewerRef, onSelect) {
  const pickerRef = useRef(null);
  // The callback changes identity every render; the picker is built once, so it reads the latest
  // through a ref rather than being rebuilt to capture it.
  const handlerRef = useRef(onSelect);
  handlerRef.current = onSelect;
  // Bumped when the picker is created, so hooks that need it re-run their install effect.
  const readyRef = useRef(0);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || pickerRef.current) return undefined;
    pickerRef.current = createMapPicker(viewer, { onSelect: hit => handlerRef.current?.(hit) });
    readyRef.current += 1;
    return () => { pickerRef.current?.destroy(); pickerRef.current = null; };
  }, [viewerRef]);

  return pickerRef;
}
