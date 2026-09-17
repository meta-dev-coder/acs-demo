/**
 * Contextual mini-map — the corridor on a real basemap, the browsed assets on it, the selection
 * marked.
 *
 * A canvas rather than a second map engine: §8 wants contextual navigation, not another GIS
 * surface, and a second Cesium viewer would double the scene cost for a 280px strip. The tiles come
 * from the same Esri service the app's own basemap already uses, so no new provider is introduced
 * and the existing attribution requirement is simply carried over.
 *
 * Tiles are fetched once per size and cached; a selection change repaints from the cache rather
 * than refetching anything.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Paper, Typography, useTheme } from '@mui/material';
import { miniMapView, tilesFor } from './miniMapProjection.js';

/** Same Esri service family as the Cesium base layer — a street map rather than imagery, because
 *  at this size the corridor has to read as a route, not as roofs. */
export const TILE_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile';
export const TILE_CREDIT = 'Esri';

const tileUrl = tile => `${TILE_URL}/${tile.z}/${tile.y}/${tile.x}`;

/** The mini-map's own padding; the canvas gets whatever height is left after it. */
const FRAME_PX = 12;
export const MIN_MAP_HEIGHT = 120;

export function AssetMiniMap({ centerline, assets, selectedAsset, onSelect, width = 280, height: outerHeight = 0 }) {
  // Told how tall to be by the group so it matches the browser beside it; falls back to a sensible
  // size before the first measurement lands.
  const height = Math.max(MIN_MAP_HEIGHT, (outerHeight || MIN_MAP_HEIGHT + FRAME_PX) - FRAME_PX);
  const canvasRef = useRef(null);
  const tileCache = useRef(new Map());
  const [tilesVersion, setTilesVersion] = useState(0);
  const theme = useTheme();

  const view = useMemo(
    () => (centerline.length ? miniMapView(centerline, width, height) : null),
    [centerline, width, height]);

  const plotted = useMemo(
    () => (view ? assets.filter(asset => asset.coordinates)
      .map(asset => ({ asset, ...view.project(asset.coordinates.longitude, asset.coordinates.latitude) })) : []),
    [assets, view]);

  // Whether this component is still mounted — deliberately NOT a per-effect flag.
  //
  // The tiles are cached across effect runs, so only the run that created an image attaches its
  // onload. `view` changes as soon as the measured height arrives (it starts at 0), and a per-run
  // flag would be cleared by that run's cleanup while its images were still decoding: the handler
  // would then see a stale "dead" flag and skip the repaint, leaving the mini-map showing the
  // corridor line over an empty background until some other state change forced a redraw.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Load the covering tiles once. A failed tile is remembered as failed so it is not retried on
  // every repaint — the map still draws, just without that square.
  useEffect(() => {
    if (!view) return;
    for (const tile of tilesFor(view)) {
      const url = tileUrl(tile);
      if (tileCache.current.has(url)) continue;
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => { if (mounted.current) setTilesVersion(version => version + 1); };
      image.onerror = () => {
        tileCache.current.set(url, null);
        // Repaint anyway: the ground colour and corridor must not wait on a tile that failed.
        if (mounted.current) setTilesVersion(version => version + 1);
      };
      image.src = url;
      tileCache.current.set(url, image);
    }
  }, [view]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view) return;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio;
      canvas.height = height * ratio;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    // A ground colour under the tiles, so a slow or blocked tile leaves a map-like surface rather
    // than a transparent hole over the 3D scene.
    ctx.fillStyle = theme.palette.background.default;
    ctx.fillRect(0, 0, width, height);

    for (const tile of tilesFor(view)) {
      const image = tileCache.current.get(tileUrl(tile));
      if (image?.complete && image.naturalWidth > 0) {
        ctx.drawImage(image, tile.left, tile.top);
      }
    }

    // The corridor, drawn twice: a light casing so the route reads over both the pale street map
    // and the dark fallback.
    ctx.beginPath();
    centerline.forEach((point, i) => {
      const { x, y } = view.project(point.lon, point.lat);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.strokeStyle = theme.palette.primary.main;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Every asset is plotted. Along a 15-mile corridor 47 cameras sit only a few pixels apart, so
    // they are drawn small and unoutlined: a dense run reads as a band of dots over the route
    // rather than a solid bar, and the corridor line still shows between them.
    for (const { asset, x, y } of plotted) {
      if (asset.id === selectedAsset?.id) continue;   // drawn last, on top
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = theme.palette.background.default;
      ctx.fill();
    }

    const selected = plotted.find(point => point.asset.id === selectedAsset?.id);
    if (selected) {
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = theme.palette.warning.main;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
  }, [centerline, plotted, selectedAsset?.id, view, width, height, theme, tilesVersion]);

  const handleClick = useCallback(event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    let best = null;
    for (const point of plotted) {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance <= 12 && (!best || distance < best.distance)) best = { distance, asset: point.asset };
    }
    if (best) onSelect(best.asset);
  }, [plotted, onSelect]);

  if (!centerline.length) return null;

  return (
    <Paper elevation={0} sx={{ p: 0.75, borderRadius: 2 }}>
      <Box sx={{ position: 'relative', lineHeight: 0 }}>
        <canvas
          ref={canvasRef}
          onClick={handleClick}
          role="img"
          aria-label={selectedAsset
            ? `I-595 corridor mini-map, ${selectedAsset.name} selected of ${plotted.length} assets`
            : `I-595 corridor mini-map, ${plotted.length} assets`}
          style={{ width, height, display: 'block', cursor: 'pointer', borderRadius: 6 }}
        />
        {/* The tile provider's attribution, which using the service requires. */}
        <Typography
          variant="caption"
          sx={{
            position: 'absolute', right: 4, bottom: 2, px: 0.5, borderRadius: 0.5,
            fontSize: '0.5625rem', lineHeight: 1.4, color: 'common.white',
            bgcolor: 'rgba(11,23,41,0.65)', pointerEvents: 'none',
          }}
        >
          {TILE_CREDIT}
        </Typography>
      </Box>
    </Paper>
  );
}
