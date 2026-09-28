/**
 * The Related tab: everything the other maintenance classes say about the record on screen.
 *
 * Shared by the incident panel and the generic details panel, because "what else is on this asset"
 * is the same question whichever class you opened. The joins themselves live in
 * `relatedRecords.js` — this file only draws them, and is careful to keep the two kinds apart: a
 * named reference is a fact the sheet prints, a shared asset is an observation about two records
 * standing in the same place.
 *
 * Clicking one opens it, which means switching the workspace to its class, selecting it and letting
 * the map follow — the same path a search hit takes, so nothing here is a second way to select.
 */
import { useMemo, useState } from 'react';
import { Box, Button, Chip, Stack, Typography } from '@mui/material';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import { AssetTypeIcon } from './AssetTypeIcon.jsx';
import { assetTypeConfig, maintenanceDate } from './assetTypes.js';
import { liveEventRelatedGroups, relatedRecordCount, relatedRecordGroups } from './relatedRecords.js';

/** A class with more than this many related records is capped until the operator asks for the rest. */
const PREVIEW = 6;

/** The groups for one record, memoised — the join walks every loaded class, which is not free. */
export function useRelatedGroups(record, lookupRecords) {
  return useMemo(
    () => (record && lookupRecords ? relatedRecordGroups(record, lookupRecords) : []),
    [record, lookupRecords],
  );
}

/** The same, for an FL511 live event: what the register holds for the event on screen. */
export function useLiveEventRelatedGroups(event, lookupRecords) {
  return useMemo(
    () => (event && lookupRecords ? liveEventRelatedGroups(event, lookupRecords) : []),
    [event, lookupRecords],
  );
}

export { relatedRecordCount };

function RelatedItem({ assetType, entry, onOpen }) {
  const { record, reason, named } = entry;
  const config = assetTypeConfig(assetType);
  const date = maintenanceDate(record.createdDate);
  return (
    <Box
      component="button"
      type="button"
      onClick={() => onOpen?.({ assetType, id: record.id })}
      disabled={!onOpen}
      aria-label={`Open ${config?.singular ?? 'record'} ${record.id}`}
      sx={{
        display: 'flex', gap: 1, alignItems: 'flex-start', width: '100%', textAlign: 'left',
        p: 1, borderRadius: 1.5, border: 1, borderColor: 'divider', bgcolor: 'transparent',
        color: 'inherit', font: 'inherit', cursor: onOpen ? 'pointer' : 'default',
        '&:hover': onOpen ? { borderColor: 'primary.main', bgcolor: 'action.hover' } : null,
      }}
    >
      <AssetTypeIcon
        assetType={assetType}
        asset={{ assetType, source: record }}
        fontSize="small"
        sx={{ color: 'text.secondary', mt: '2px' }}
      />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle2" noWrap>{record.id}</Typography>
        {record.title && record.title !== record.id && (
          <Typography variant="caption" color="text.secondary" component="div" noWrap>{record.title}</Typography>
        )}
        <Typography variant="caption" color="text.secondary" component="div" noWrap>
          {[record.status, date].filter(Boolean).join(' · ')}
        </Typography>
        {/* Why these two records are together, said in full — a shared asset is not causation. */}
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mt: 0.25 }}>
          {named && <LinkOutlinedIcon sx={{ fontSize: 13, color: 'primary.main' }} />}
          <Typography variant="caption" sx={{ color: named ? 'primary.main' : 'text.secondary' }} noWrap>
            {reason}
          </Typography>
        </Stack>
      </Box>
    </Box>
  );
}

/**
 * @param {{groups: object[], onOpen?: (ref: {assetType: string, id: string}) => void,
 *          emptyMessage?: string}} props
 */
export function RelatedRecords({ groups, onOpen, emptyMessage = 'No other record names this one or stands on its asset.' }) {
  const [expanded, setExpanded] = useState(() => new Set());
  if (!groups.length) return <Typography variant="body2" color="text.secondary">{emptyMessage}</Typography>;
  return (
    <Stack spacing={1.5}>
      {groups.map(group => {
        const open = expanded.has(group.assetType);
        const shown = open ? group.items : group.items.slice(0, PREVIEW);
        return (
          <Box key={group.assetType}>
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mb: 0.75 }}>
              <Typography variant="subtitle2">{group.label}</Typography>
              <Chip size="small" variant="outlined" label={group.items.length} />
            </Stack>
            <Stack spacing={0.75}>
              {shown.map(entry => (
                <RelatedItem key={entry.record.id} assetType={group.assetType} entry={entry} onOpen={onOpen} />
              ))}
            </Stack>
            {group.items.length > PREVIEW && (
              <Button
                size="small"
                variant="text"
                sx={{ mt: 0.5 }}
                onClick={() => setExpanded(previous => {
                  const next = new Set(previous);
                  if (next.has(group.assetType)) next.delete(group.assetType); else next.add(group.assetType);
                  return next;
                })}
              >
                {open ? 'Show fewer' : `Show all ${group.items.length}`}
              </Button>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}
