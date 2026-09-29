/**
 * The Asset Explorer island: bottom carousel, corridor rail, mini-map and details panel.
 *
 * All four read one selection from the store and write back through one `selectAsset`, so a Cesium
 * pick, a card, a mini-map marker and Next are the same operation arriving from different places.
 *
 * Layout awareness (§19): the bottom bar and the mini-map both reserve room for the details panel
 * when it is open, so nothing is ever parked underneath it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Chip, IconButton, InputBase, MenuItem, Paper, Select, Stack, ThemeProvider, Tooltip, Typography, useMediaQuery } from '@mui/material';
import CssBaseline from '@mui/material/CssBaseline';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/SearchOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { createAppTheme } from './theme.js';
import { useAssetStore } from './useAssetStore.js';
import { assetTypeConfig, todayKey } from './assetTypes.js';
import { corridorLengthMiles } from './corridorPosition.js';
import { SELECTION_SOURCES } from './assetSelectionStore.js';
import { AssetCarousel } from './AssetCarousel.jsx';
import { AssetPositionRail } from './AssetPositionRail.jsx';
import { AssetMiniMap } from './AssetMiniMap.jsx';
import { AssetDetailsPanel, DETAILS_WIDTH } from './AssetDetailsPanel.jsx';
import { IncidentDetailsPanel, INCIDENT_DETAILS_WIDTH } from './IncidentDetailsPanel.jsx';
import { IncidentTypeIcon } from './IncidentTypeIcon.jsx';
import { isLiveEventAssetType } from './liveEventPresentation.js';

/** Below this the mini-map stops earning its space and the details panel becomes an overlay. */
export const MINIMAP_MIN_WIDTH = 1100;
/** Three cards plus the two step buttons; beyond this the bar is just covering the map. */
export const EXPLORER_MAX_WIDTH = 720;
/** Sits close to the bottom edge now that no status strip runs beneath it. */
export const BOTTOM_OFFSET = 20;

/**
 * One end of the reported-date range.
 *
 * A bare `<input type="date">` themed to match the strip: it is already keyboard-accessible, already
 * shows the operator's own date format, and already refuses an impossible day — none of which a
 * hand-built picker would get right for the space of a 130px field.
 */
function DateBound({ label, value, min, max, onChange }) {
  return (
    <Box
      component="input"
      type="date"
      value={value ?? ''}
      min={min ?? undefined}
      max={max ?? undefined}
      aria-label={label}
      title={label}
      onChange={event => onChange(event.target.value)}
      sx={{
        height: 24, width: 126, px: 0.75, borderRadius: 1.5,
        border: 1, borderColor: value ? 'primary.main' : 'divider',
        bgcolor: 'action.hover', color: 'text.primary',
        font: 'inherit', fontSize: 12,
        colorScheme: theme => (theme.palette.mode === 'dark' ? 'dark' : 'light'),
        '&::-webkit-calendar-picker-indicator': { cursor: 'pointer', opacity: 0.6 },
      }}
    />
  );
}

export function AssetExplorer({
  store, centerline, leftInset = 16, rightInset: detailsInset = 16, themeMode = 'dark',
  /** Where the details panel's top edge goes — measured, so it clears this workspace's own strip. */
  panelTop = 220,
  onInspect, onReturn, onViewCamera, lookupRecords = null, onOpenRecord = null, onHighlightCameras = null,
  operationalImpactOf = null,
}) {
  const state = useAssetStore(store);
  // Rebuilt only when the mode actually changes; a new theme object on every render would remount
  // every styled node in the island.
  const theme = useMemo(() => createAppTheme(themeMode), [themeMode]);
  const { activeExplorerType, selectedAsset, explorerExpanded, detailsOpen, inspectionViewActive } = state;
  const showMiniMap = useMediaQuery(`(min-width:${MINIMAP_MIN_WIDTH}px)`);
  const compact = useMediaQuery('(max-width:820px)');

  const config = activeExplorerType ? assetTypeConfig(activeExplorerType) : null;
  const all = state.assetsByType[activeExplorerType] ?? [];
  // Search and filters live on the browser itself, so the cards, the rail, the mini-map, Next and
  // the map are all looking at the same narrowed set.
  const assets = store.filteredAssets();
  // What every filter EXCEPT the grouped ones leaves on screen — the set the type dropdown counts
  // over, so "Vehicle fire (4)" means four in the range you are looking at, not four ever.
  const counted = useMemo(() => store.filteredAssets({ id: null }), [store, state.filter, all]);
  const filters = useMemo(() => config?.getFilters?.(all, counted) ?? [], [config, all, counted]);
  // A filter with a `group` is one of many values of the same field — offered as a dropdown, because
  // a class like the incidents has fifteen types and that many chips would push the cards off screen.
  const chipFilters = useMemo(() => filters.filter(filter => !filter.group), [filters]);
  const groupedFilters = useMemo(() => {
    const groups = new Map();
    for (const filter of filters.filter(entry => entry.group)) {
      if (!groups.has(filter.group)) groups.set(filter.group, []);
      groups.get(filter.group).push(filter);
    }
    return [...groups.entries()];
  }, [filters]);
  // Only a class that actually dates its records is offered a date range. The earliest date it holds
  // is the floor; today is the ceiling, because a record dated later than now has not happened yet
  // and offering to filter "up to" it would be offering to show the future as if it were history.
  const dateBounds = useMemo(() => {
    if (!config?.getDateKey) return null;
    let min = null;
    for (const asset of all) {
      const key = config.getDateKey(asset);
      if (key && (min === null || key < min)) min = key;
    }
    return min ? { min, max: todayKey() } : null;
  }, [config, all]);
  const datesAvailable = Boolean(dateBounds);
  const status = state.statusByType[activeExplorerType] ?? { loading: false, error: null };
  const corridorMiles = useMemo(() => corridorLengthMiles(centerline), [centerline]);

  // The mini-map should be exactly as tall as the browser beside it. Its height is not a constant —
  // it changes with the collapse toggle and with how the cards wrap — so it is measured rather than
  // guessed at, and the canvas is told what to draw into.
  const [explorerHeight, setExplorerHeight] = useState(0);
  const observerRef = useRef(null);
  // A callback ref rather than an effect: this component renders null until a layer is switched on,
  // so an effect on mount would observe nothing and never look again.
  const explorerRef = useCallback(node => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setExplorerHeight(Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height));
    });
    observer.observe(node);
    observerRef.current = observer;
    setExplorerHeight(Math.round(node.getBoundingClientRect().height));
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const select = useCallback((asset, source) => { store.selectAsset(asset, source); }, [store]);
  const selectFromCard = useCallback(asset => select(asset, SELECTION_SOURCES.CARD), [select]);
  const selectFromMiniMap = useCallback(asset => select(asset, SELECTION_SOURCES.MINIMAP), [select]);
  const selectFromRail = useCallback(asset => select(asset, SELECTION_SOURCES.RAIL), [select]);
  const step = useCallback(delta => { store.step(delta); }, [store]);
  const setQuery = useCallback(event => { store.setFilter({ query: event.target.value }); }, [store]);
  // An empty date input means "no bound", not "the epoch", so it is stored as null.
  const setDate = useCallback((edge, value) => { store.setFilter({ [edge]: value || null }); }, [store]);
  const toggleFilter = useCallback(id => { store.setFilter({ id: store.getState().filter.id === id ? null : id }); }, [store]);

  if (!config) return null;

  // Reserve the details panel's column so the bottom bar never slides underneath it.
  // A type that keeps its own details panel gets no second one here; two panels describing the
  // same asset is worse than either alone.
  const detailsShowing = detailsOpen && Boolean(selectedAsset) && !config.legacyDetailsPanel;
  // An incident is an event to be acted on rather than a record to be read, so it has its own panel
  // — the type's colour, the nearest camera and the impact — instead of the shared field list.
  // The rich panel serves the maintenance incident register and Live Ops' five operational feeds:
  // both are events an operator acts on, read the same way, so they get the same surface.
  const showingIncident = detailsShowing
    && (selectedAsset.assetType === 'incidentRecord' || isLiveEventAssetType(selectedAsset.assetType));
  const openPanelWidth = showingIncident ? INCIDENT_DETAILS_WIDTH : DETAILS_WIDTH;
  // The bottom group keeps a fixed position: selecting an asset must not slide the browser out from
  // under the cursor. It can afford to, because the mini-map sits to the LEFT of the browser — the
  // only thing that reaches toward the details panel is the browser's own right edge, and a centred
  // browser of EXPLORER_MAX_WIDTH stops well short of it. The panel's width is still subtracted
  // when the Map Explorer is also open, which is the one case where the two could otherwise meet.
  const rightInset = Math.max(detailsInset, detailsShowing && !compact && leftInset > 16 ? openPanelWidth + 32 : 16);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline enableColorScheme={false} />
      {/* The island covers the map, so it must not intercept pointer events except on its own
          surfaces — Cesium navigation has to keep working around it. */}
      <Box sx={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {detailsShowing && (showingIncident ? (
          <IncidentDetailsPanel
            right={detailsInset}
            top={panelTop}
            asset={selectedAsset}
            inspecting={inspectionViewActive}
            onClose={() => store.setDetailsOpen(false)}
            onInspect={onInspect}
            onReturn={onReturn}
            onViewCamera={onViewCamera}
            operationalImpactOf={operationalImpactOf}
            lookupRecords={lookupRecords}
            onOpenRecord={onOpenRecord}
            onHighlightCameras={onHighlightCameras}
          />
        ) : (
          <AssetDetailsPanel
            right={detailsInset}
            top={panelTop}
            asset={selectedAsset}
            inspecting={inspectionViewActive}
            onClose={() => store.setDetailsOpen(false)}
            onInspect={onInspect}
            onReturn={onReturn}
            onViewCamera={onViewCamera}
            lookupRecords={lookupRecords}
            onOpenRecord={onOpenRecord}
          />
        ))}

        {/* One bottom navigation group. The browser and the mini-map stay separate Material
            surfaces, but they are a single workspace: this container owns the bottom offset, the
            horizontal alignment and the gap, and neither child positions itself. Its left and right
            edges are the Map Explorer and the details panel, so the pair centres on the Cesium
            workspace that is actually free rather than on the browser window. */}
        <Box
          sx={{
            position: 'absolute', left: leftInset, right: rightInset, bottom: BOTTOM_OFFSET, zIndex: 12,
            // Three columns rather than a centred row: the middle column holds the browser, so the
            // browser itself is centred on the workspace. A flex row would centre the PAIR, which
            // pushes the browser right of centre by half the mini-map's width.
            // The middle column is pinned rather than `auto`: an auto column is sized by its
            // content, so the selected card's 2px border was enough to re-measure it and make the
            // browser visibly change width on every selection.
            display: 'grid',
            gridTemplateColumns: `1fr minmax(0, ${EXPLORER_MAX_WIDTH}px) 1fr`,
            alignItems: 'end', gap: 1.5,
            pointerEvents: 'none',
            // The workspace changes width when the details panel or the Map Explorer opens; easing
            // it keeps the group from appearing to jump sideways.
            transition: theme => theme.transitions.create(['left', 'right'], { duration: 180 }),
          }}
        >
          {/* Column 1, pushed to its right edge so it sits immediately beside the browser. */}
          <Box sx={{ justifySelf: 'end', pointerEvents: 'auto' }}>
            {/* Shown in every workspace. Live Ops used to give this corner back to the Cesium view,
                on the grounds that a second map repeated its spatial context — but at corridor scale
                the globe is zoomed too far in to show where along the 15 miles a card sits, which is
                exactly what this strip answers. */}
            {showMiniMap && explorerExpanded && (
              <AssetMiniMap
                centerline={centerline}
                assets={assets}
                selectedAsset={selectedAsset}
                onSelect={selectFromMiniMap}
                height={explorerHeight}
              />
            )}
          </Box>

          <Paper
            ref={explorerRef}
            elevation={6}
            // The browser gives up width first as the workspace narrows; the mini-map keeps its
            // size until the breakpoint drops it entirely.
            sx={{ width: '100%', minWidth: 0, maxWidth: EXPLORER_MAX_WIDTH, pointerEvents: 'auto', overflow: 'hidden' }}
            role="region"
            aria-label={`${config.label} explorer`}
          >
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 1.5, py: 1 }}>
              <Typography variant="h6">{config.label}</Typography>
              {/* What is on screen, full stop. "22 of 181" invited the question "why am I not seeing
                  the other 159", whose answer is the date range sitting right beside this chip. */}
              <Chip
                label={status.loading ? '…'
                  : `${assets.length.toLocaleString('en-US')} ${assets.length === 1 ? 'asset' : 'assets'}`}
                size="small" variant="outlined"
              />
              <Box sx={{ flex: 1 }} />
              {(all.length > 8 || state.filter.query) && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.25, borderRadius: 1.5,
                  border: 1, borderColor: 'divider', bgcolor: 'action.hover', minWidth: 0, width: compact ? 120 : 170 }}>
                  <SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                  <InputBase
                    value={state.filter.query}
                    onChange={setQuery}
                    placeholder={`Search ${config.label.toLowerCase()}`}
                    inputProps={{ 'aria-label': `Search ${config.label.toLowerCase()}` }}
                    sx={{ fontSize: 12.5, flex: 1, minWidth: 0 }}
                  />
                </Box>
              )}
              <Tooltip title={explorerExpanded ? 'Collapse' : 'Expand'}>
                <IconButton
                  onClick={() => store.setExplorerExpanded(!explorerExpanded)}
                  aria-label={explorerExpanded ? `Collapse ${config.label} explorer` : `Expand ${config.label} explorer`}
                  aria-expanded={explorerExpanded}
                >
                  {explorerExpanded ? <ExpandMoreIcon /> : <ExpandLessIcon />}
                </IconButton>
              </Tooltip>
              <Tooltip title="Close explorer">
                <IconButton onClick={() => store.setActiveExplorerType(null)} aria-label={`Close ${config.label} explorer`}>
                  <CloseIcon />
                </IconButton>
              </Tooltip>
            </Stack>
            {explorerExpanded && (filters.length > 0 || datesAvailable) && (
              <Stack direction="row" spacing={0.75} sx={{ px: 1.5, pb: 0.5, flexWrap: 'wrap', rowGap: 0.75 }}>
                {/* "All" is the state with no filter, named so it can be chosen rather than guessed at. */}
                <Chip
                  label="All"
                  size="small"
                  variant={state.filter.id === null ? 'filled' : 'outlined'}
                  color={state.filter.id === null ? 'primary' : 'default'}
                  onClick={() => store.setFilter({ id: null })}
                  aria-pressed={state.filter.id === null}
                />
                {chipFilters.map(filter => (
                  <Chip
                    key={filter.id}
                    label={filter.label}
                    size="small"
                    variant={state.filter.id === filter.id ? 'filled' : 'outlined'}
                    color={state.filter.id === filter.id ? 'primary' : 'default'}
                    onClick={() => toggleFilter(filter.id)}
                    aria-pressed={state.filter.id === filter.id}
                  />
                ))}
                {groupedFilters.map(([group, entries]) => {
                  const chosen = entries.some(entry => entry.id === state.filter.id) ? state.filter.id : '';
                  return (
                    <Select
                      key={group}
                      size="small"
                      displayEmpty
                      value={chosen}
                      onChange={event => store.setFilter({ id: event.target.value || null })}
                      inputProps={{ 'aria-label': group }}
                      sx={{ height: 24, fontSize: 13, '& .MuiSelect-select': { py: 0, pl: 1 } }}
                    >
                      {/* Choosing nothing is choosing every type, and is named so rather than blank. */}
                      <MenuItem value="">{`All ${group.toLowerCase()}s`}</MenuItem>
                      {entries.map(entry => (
                        <MenuItem key={entry.id} value={entry.id} sx={{ gap: 1 }}>
                          {/* The crash taxonomy carries its own colour and pictogram; every other
                              grouped filter is plain text, so nothing else gains a stray icon. */}
                          {group === 'Incident type' && <IncidentTypeIcon incidentType={entry.label} fontSize="small" />}
                          {`${entry.label} (${entry.count})`}
                        </MenuItem>
                      ))}
                    </Select>
                  );
                })}
                {/* The reported-date range. Native date inputs rather than a picker component: they
                    are keyboard- and locale-correct for free, and this strip has room for two
                    fields, not a calendar popover. */}
                {datesAvailable && (
                  <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                      {`${config.dateLabel ?? 'Reported'}`}
                    </Typography>
                    <DateBound
                      label={`${config.dateLabel ?? 'Reported'} on or after`}
                      value={state.filter.from}
                      min={dateBounds.min}
                      max={state.filter.to ?? dateBounds.max}
                      onChange={value => setDate('from', value)}
                    />
                    <Typography variant="caption" color="text.secondary">to</Typography>
                    <DateBound
                      label={`${config.dateLabel ?? 'Reported'} on or before`}
                      value={state.filter.to}
                      min={state.filter.from ?? dateBounds.min}
                      max={dateBounds.max}
                      onChange={value => setDate('to', value)}
                    />
                    {(state.filter.from || state.filter.to) && (
                      <Tooltip title="Clear the date range">
                        <IconButton
                          aria-label="Clear the date range"
                          onClick={() => store.setFilter({ from: null, to: null })}
                          sx={{ width: 22, height: 22 }}
                        >
                          <CloseIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                  </Stack>
                )}
              </Stack>
            )}
            {explorerExpanded && (
              <>
                <AssetCarousel
                  assets={assets}
                  selectedAsset={selectedAsset}
                  singular={config.singular}
                  status={status}
                  emptyMessage={config.emptyMessage}
                  errorMessage={config.errorMessage}
                  onSelect={selectFromCard}
                  onStep={step}
                />
                <AssetPositionRail
                  assets={assets}
                  selectedId={selectedAsset?.id ?? null}
                  corridorMiles={corridorMiles}
                  onSelect={selectFromRail}
                />
              </>
            )}
          </Paper>
        </Box>
      </Box>
    </ThemeProvider>
  );
}
