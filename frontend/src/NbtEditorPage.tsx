import {
  faChevronDown,
  faChevronRight,
  faFileCode,
  faFolderOpen,
  faRotateLeft,
  faRotateRight,
  faSave,
  faSearch,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Alert, Badge, Group, ScrollArea, Skeleton, Stack, Text, Title } from '@mantine/core';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createSearchParams, useNavigate, useSearchParams } from 'react-router';
import { httpErrorToHuman } from '@/api/axios.ts';
import Button from '@/elements/Button.tsx';
import Card from '@/elements/Card.tsx';
import ServerContentContainer from '@/elements/containers/ServerContentContainer.tsx';
import Select from '@/elements/input/Select.tsx';
import ConfirmationModal from '@/elements/modals/ConfirmationModal.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import { useBlocker } from '@/plugins/useBlocker.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import { useServerStore } from '@/stores/server.ts';
import { readNbtFile, saveNbtFile, type NbtNode, type ParsedNbt } from './api.ts';

type NbtPath = Array<string | number>;
type ExpandSignal = { id: number; open: boolean } | null;
const CHILD_RENDER_BATCH = 200;

const editionOptions = [
  { label: 'Auto detect', value: 'auto' },
  { label: 'Java', value: 'java' },
  { label: 'Bedrock', value: 'bedrock' },
];

const editableKinds = new Set(['byte', 'short', 'int', 'long', 'float', 'double', 'string']);

const tagColor = (tagType: string) => {
  switch (tagType) {
    case 'compound':
      return '#35ff2d';
    case 'list':
      return '#35ff2d';
    case 'string':
      return '#ffd02a';
    case 'byte':
    case 'short':
    case 'int':
    case 'long':
    case 'float':
    case 'double':
      return '#38d6ff';
    default:
      return 'var(--mantine-color-gray-5)';
  }
};

const scalarValue = (node: NbtNode) => {
  switch (node.value.kind) {
    case 'byte':
    case 'short':
    case 'int':
    case 'long':
    case 'float':
    case 'double':
      return String(node.value.value);
    case 'string':
      return node.value.value;
    case 'byteArray':
    case 'intArray':
    case 'longArray':
      return `${node.value.length} values [${node.value.preview.join(', ')}${node.value.preview.length < node.value.length ? ', ...' : ''}]`;
    default:
      return '';
  }
};

const nodeMatches = (node: NbtNode, name: string, query: string): boolean => {
  if (!query) return true;
  const needle = query.toLowerCase();
  if (name.toLowerCase().includes(needle) || node.tagType.toLowerCase().includes(needle) || scalarValue(node).toLowerCase().includes(needle)) {
    return true;
  }

  if (node.value.kind === 'compound') {
    return node.value.entries.some((entry) => nodeMatches(entry.node, entry.name, query));
  }

  if (node.value.kind === 'list') {
    return node.value.items.some((item, index) => nodeMatches(item, `[${index}]`, query));
  }

  return false;
};

const formatFileCrumbs = (file: string) => file.split('/').filter(Boolean);

const formatCompression = (compression: ParsedNbt['compression']) => {
  switch (compression) {
    case 'gzip':
      return 'GZIP';
    case 'zlib':
      return 'ZLIB';
    default:
      return 'NONE';
  }
};

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(max-width: 720px)').matches,
  );

  useEffect(() => {
    const media = window.matchMedia('(max-width: 720px)');
    const update = () => setIsMobile(media.matches);

    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return isMobile;
}

const cloneNodeWithValue = (node: NbtNode, path: NbtPath, value: string): NbtNode => {
  if (path.length === 0) {
    if (!editableKinds.has(node.value.kind)) return node;

    switch (node.value.kind) {
      case 'string':
        return { ...node, value: { ...node.value, value } };
      case 'byte':
      case 'short':
      case 'int':
      case 'long':
        return { ...node, value: { ...node.value, value: Number.parseInt(value || '0', 10) } };
      case 'float':
      case 'double':
        return { ...node, value: { ...node.value, value: Number.parseFloat(value || '0') } };
      default:
        return node;
    }
  }

  if (node.value.kind === 'compound') {
    const [index, ...rest] = path;
    if (typeof index !== 'number') return node;

    return {
      ...node,
      value: {
        ...node.value,
        entries: node.value.entries.map((entry, entryIndex) =>
          entryIndex === index ? { ...entry, node: cloneNodeWithValue(entry.node, rest, value) } : entry,
        ),
      },
    };
  }

  if (node.value.kind === 'list') {
    const [index, ...rest] = path;
    if (typeof index !== 'number') return node;

    return {
      ...node,
      value: {
        ...node.value,
        items: node.value.items.map((item, itemIndex) => (itemIndex === index ? cloneNodeWithValue(item, rest, value) : item)),
      },
    };
  }

  return node;
};

const NbtRow = memo(function NbtRow({
  node,
  name,
  depth = 0,
  query,
  path,
  expandSignal,
  isMobile,
  onChange,
  setDirty,
}: {
  node: NbtNode;
  name: string;
  depth?: number;
  query: string;
  path: NbtPath;
  expandSignal: ExpandSignal;
  isMobile: boolean;
  onChange: (path: NbtPath, value: string) => void;
  setDirty: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const scalar = scalarValue(node);
  const [draft, setDraft] = useState(scalar);
  const [error, setError] = useState(false);
  const [visibleChildren, setVisibleChildren] = useState(CHILD_RENDER_BATCH);
  const isCompound = node.value.kind === 'compound';
  const isList = node.value.kind === 'list';
  const expandable = isCompound || isList;
  const editable = editableKinds.has(node.value.kind);
  const indent = depth * (isMobile ? 10 : 16);

  useEffect(() => {
    setDraft(scalar);
    setError(false);
  }, [scalar]);

  useEffect(() => {
    if (!expandSignal) return;
    setOpen(expandSignal.open || depth === 0);
    setVisibleChildren(CHILD_RENDER_BATCH);
  }, [depth, expandSignal]);

  const validate = useCallback((val: string) => {
    if (!editable) return false;
    const kind = node.value.kind;
    if (kind === 'byte' || kind === 'short' || kind === 'int' || kind === 'long') {
      if (val === '-' || val === '') return true;
      const parsed = Number.parseInt(val, 10);
      if (Number.isNaN(parsed)) return false;
      if (kind === 'byte' && (parsed < -128 || parsed > 127)) return false;
      if (kind === 'short' && (parsed < -32768 || parsed > 32767)) return false;
      if (kind === 'int' && (parsed < -2147483648 || parsed > 2147483647)) return false;
      return true;
    }
    if (kind === 'float' || kind === 'double') {
      if (val === '-' || val === '.' || val === '-.' || val === '') return true;
      if (/^-?\d*\.?\d*$/.test(val)) {
        const parsed = Number.parseFloat(val);
        return !Number.isNaN(parsed);
      }
      return false;
    }
    return true;
  }, [editable, node.value.kind]);

  const commit = useCallback(() => {
    if (editable && draft !== scalar) {
      if (validate(draft)) {
        let finalVal = draft;
        if (draft === '' || draft === '-' || draft === '.' || draft === '-.') {
          finalVal = '0';
        }
        onChange(path, finalVal);
        setError(false);
      } else {
        setDraft(scalar);
        setError(false);
      }
    }
  }, [draft, editable, onChange, path, scalar, validate]);

  const updateDraft = useCallback((value: string) => {
    setDraft(value);
    const isValid = validate(value);
    setError(!isValid);
    if (isValid && value !== scalar) {
      setDirty(true);
    }
  }, [validate, scalar, setDirty]);

  if (!nodeMatches(node, name, query)) return null;

  const childCount = isCompound ? node.value.entries.length : isList ? node.value.length : 0;
  const childLabel = isCompound ? `${childCount} tag${childCount === 1 ? '' : 's'}` : isList ? `${childCount} ${node.value.elementType} item${childCount === 1 ? '' : 's'}` : '';
  const childLimit = query ? childCount : Math.min(childCount, visibleChildren);
  const hiddenChildren = query ? 0 : Math.max(0, childCount - childLimit);

  return (
    <Stack gap={0}>
      <Group
        gap='xs'
        wrap={isMobile && editable ? 'wrap' : 'nowrap'}
        style={{
          minHeight: isMobile ? 48 : depth === 0 ? 36 : 38,
          paddingLeft: indent,
          paddingRight: isMobile ? 10 : 8,
          paddingTop: isMobile ? 8 : 0,
          paddingBottom: isMobile ? 8 : 0,
          borderRadius: isMobile ? 8 : 5,
          background: isMobile && depth > 0 ? 'rgba(255, 255, 255, 0.018)' : undefined,
        }}
      >
        <button
          type='button'
          disabled={!expandable}
          onClick={() => setOpen((value) => !value)}
          style={{
            width: 20,
            height: 20,
            border: 0,
            padding: 0,
            background: 'transparent',
            color: 'inherit',
            cursor: expandable ? 'pointer' : 'default',
            opacity: expandable ? 0.72 : 0,
          }}
          aria-label={open ? 'Collapse tag' : 'Expand tag'}
        >
          <FontAwesomeIcon icon={open ? faChevronDown : faChevronRight} size='xs' />
        </button>
        <Text
          size='sm'
          fw={800}
          ff='monospace'
          style={{
            width: isMobile ? 58 : 'clamp(46px, 13vw, 80px)',
            minWidth: isMobile ? 58 : 'clamp(46px, 13vw, 80px)',
            color: tagColor(node.tagType),
            textTransform: 'uppercase',
            textAlign: 'right',
          }}
        >
          {node.tagType}
        </Text>
        <Text
          size='sm'
          fw={700}
          title={name || '(root)'}
          style={{
            minWidth: isMobile ? 0 : depth === 0 ? 58 : 68,
            maxWidth: isMobile ? 'clamp(92px, 28vw, 240px)' : 'clamp(92px, 28vw, 240px)',
            flex: isMobile ? '1 1 0' : undefined,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name || '(root)'}
        </Text>
        {childLabel ? (
          <Text size='xs' c='dimmed' style={{ whiteSpace: 'nowrap' }}>
            {childLabel}
          </Text>
        ) : editable ? (
          <input
            value={draft}
            onChange={(event) => updateDraft(event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                setDraft(scalar);
                setError(false);
                event.currentTarget.blur();
              }
            }}
            style={{
              flex: isMobile ? '1 0 100%' : 1,
              minWidth: isMobile ? 0 : 128,
              height: isMobile ? 42 : 32,
              border: error ? '1px solid #ff6b6b' : '1px solid rgba(255, 255, 255, 0.075)',
              borderRadius: isMobile ? 8 : 4,
              background: error ? 'rgba(255, 107, 107, 0.15)' : 'rgba(10, 11, 16, 0.42)',
              color: 'inherit',
              padding: isMobile ? '0 12px' : '0 10px',
              fontFamily: 'monospace',
              fontSize: isMobile ? 16 : 14,
              outline: 'none',
              transition: 'border-color 0.2s, background-color 0.2s',
            }}
          />
        ) : (
          <Text size='sm' ff='monospace' c='dimmed' lineClamp={1}>
            {scalar}
          </Text>
        )}
      </Group>

      {open && expandable ? (
        <Stack
          gap={0}
          style={{
            marginLeft: indent + (isMobile ? 12 : 24),
            paddingLeft: isMobile ? 8 : 12,
            borderLeft: '1px solid rgba(255, 255, 255, 0.075)',
          }}
        >
          {isCompound
            ? node.value.entries.slice(0, childLimit).map((entry, index) => (
                <NbtRow
                  key={`${entry.name}-${index}`}
                  node={entry.node}
                  name={entry.name}
                  depth={depth + 1}
                  query={query}
                  path={[...path, index]}
                  expandSignal={expandSignal}
                  isMobile={isMobile}
                  onChange={onChange}
                  setDirty={setDirty}
                />
              ))
            : null}

          {isList
            ? node.value.items.slice(0, childLimit).map((item, index) => (
                <NbtRow
                  key={index}
                  node={item}
                  name={`[${index}]`}
                  depth={depth + 1}
                  query={query}
                  path={[...path, index]}
                  expandSignal={expandSignal}
                  isMobile={isMobile}
                  onChange={onChange}
                  setDirty={setDirty}
                />
              ))
            : null}
          {hiddenChildren > 0 ? (
            <button
              type='button'
              onClick={() => setVisibleChildren((current) => current + CHILD_RENDER_BATCH)}
              style={{
                alignSelf: 'flex-start',
                margin: '6px 0 6px 20px',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: isMobile ? 8 : 5,
                background: 'rgba(255, 255, 255, 0.035)',
                color: 'inherit',
                cursor: 'pointer',
                padding: isMobile ? '10px 12px' : '6px 10px',
                fontSize: 13,
              }}
            >
              Show {Math.min(CHILD_RENDER_BATCH, hiddenChildren)} more ({hiddenChildren} hidden)
            </button>
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  );
});

function ResultPanel({
  parsed,
  query,
  deferredQuery,
  dirty,
  expandSignal,
  isMobile,
  onQueryChange,
  onExpandAll,
  onCollapseAll,
  onRevert,
  onChange,
  setDirty,
}: {
  parsed: ParsedNbt;
  query: string;
  deferredQuery: string;
  dirty: boolean;
  expandSignal: ExpandSignal;
  isMobile: boolean;
  onQueryChange: (value: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onRevert: () => void;
  onChange: (path: NbtPath, value: string) => void;
  setDirty: (value: boolean) => void;
}) {
  const rootName = parsed.rootName || '(root)';
  const rootType = parsed.root.tagType === 'compound' ? 'COMPOUND ROOT' : `${parsed.root.tagType.toUpperCase()} ROOT`;

  return (
    <Card p={0} style={{ overflow: 'hidden' }}>
      <Stack gap={0}>
        <Group gap='xs' p={isMobile ? 'xs' : 'sm'} wrap='wrap'>
          <TextInput
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder='Search keys and values...'
            leftSection={<FontAwesomeIcon icon={faSearch} />}
            style={{ flex: isMobile ? '1 0 100%' : '1 1 360px' }}
          />
          <Button variant='light' onClick={onExpandAll} style={{ flex: isMobile ? '1 1 0' : '0 0 auto', minHeight: isMobile ? 44 : undefined }}>
            Expand all
          </Button>
          <Button variant='light' onClick={onCollapseAll} style={{ flex: isMobile ? '1 1 0' : '0 0 auto', minHeight: isMobile ? 44 : undefined }}>
            Collapse all
          </Button>
          <Button
            variant='light'
            disabled={!dirty}
            onClick={onRevert}
            leftSection={<FontAwesomeIcon icon={faRotateLeft} />}
            style={{ flex: isMobile ? '1 0 100%' : '0 0 auto', minHeight: isMobile ? 44 : undefined }}
          >
            Revert
          </Button>
        </Group>
        <Group
          gap='xs'
          px={isMobile ? 'xs' : 'sm'}
          py={8}
          wrap={isMobile ? 'nowrap' : 'wrap'}
          style={{
            borderTop: '1px solid var(--mantine-color-dark-5)',
            borderBottom: '1px solid var(--mantine-color-dark-5)',
            overflowX: isMobile ? 'auto' : undefined,
            color: '#fff',
          }}
        >
          <Text size='xs' style={{ color: '#fff', opacity: 0.82, whiteSpace: 'nowrap' }}>
            Detected format
          </Text>
          <Badge size='sm' variant='filled' color='gray' style={{ color: '#fff' }}>
            {formatCompression(parsed.compression)}
          </Badge>
          <Badge size='sm' variant='filled' color='gray' style={{ color: '#fff' }}>
            {parsed.edition === 'bedrock' ? 'LITTLE ENDIAN' : 'BIG ENDIAN'}
          </Badge>
          <Badge size='sm' variant='filled' color='gray' style={{ color: '#fff' }}>
            {rootType}
          </Badge>
          <Badge size='sm' variant='filled' color='gray' style={{ color: '#fff' }}>
            {parsed.rootName ? 'NAMED ROOT' : 'EMPTY NAME'}
          </Badge>
          <Text size='xs' style={{ color: '#fff', opacity: 0.82, whiteSpace: 'nowrap' }}>
            {rootName}
          </Text>
        </Group>
        <ScrollArea h={isMobile ? 'calc(100dvh - 330px)' : 'calc(100dvh - 250px)'} mah={780} mih={isMobile ? 360 : 320} type='auto'>
          <Stack gap={isMobile ? 6 : 2} p={isMobile ? 'xs' : 'sm'} style={{ minWidth: 'max-content', width: '100%' }}>
            <NbtRow
              node={parsed.root}
              name={rootName}
              query={deferredQuery}
              path={[]}
              expandSignal={expandSignal}
              isMobile={isMobile}
              onChange={onChange}
              setDirty={setDirty}
            />
          </Stack>
        </ScrollArea>
      </Stack>
    </Card>
  );
}

function LoadingPanel() {
  return (
    <Card p='md'>
      <Stack gap='sm'>
        <Skeleton height={34} radius='sm' />
        <Skeleton height={28} radius='sm' width='88%' />
        <Skeleton height={28} radius='sm' width='74%' />
        <Skeleton height={28} radius='sm' width='64%' />
      </Stack>
    </Card>
  );
}

export default function NbtEditorPage() {
  const server = useServerStore((state) => state.server);
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryFile = searchParams.get('file');
  const [file, setFile] = useState(queryFile ?? '/world/level.dat');
  const [edition, setEdition] = useState('auto');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [expandSignal, setExpandSignal] = useState<ExpandSignal>(null);
  const [result, setResult] = useState<{ file: string; parsed: ParsedNbt } | null>(null);
  const resultRef = useRef(result);
  resultRef.current = result;
  const isMobile = useIsMobile();
  const blocker = useBlocker(dirty);
  const fileName = useMemo(() => file.split('/').filter(Boolean).pop() ?? file, [file]);
  const breadcrumbs = useMemo(() => formatFileCrumbs(file), [file]);
  const saveStatus = saving ? 'Saving...' : dirty ? 'Unsaved changes' : result ? 'Saved' : '';
  const confirmDiscardChanges = useCallback(() => {
    if (!dirty) return true;
    return window.confirm('You have unsaved NBT changes. Leave without saving?');
  }, [dirty]);
  const openBreadcrumb = useCallback((index: number) => {
    if (!server?.uuidShort) return;
    if (!confirmDiscardChanges()) return;

    const directory = `/${breadcrumbs.slice(0, index + 1).join('/')}`.replace(/\/+/g, '/');
    const to = `/server/${server.uuidShort}/files?${createSearchParams({ directory })}`;
    if (dirty) {
      setDirty(false);
      window.setTimeout(() => navigate(to), 0);
      return;
    }

    navigate(to);
  }, [breadcrumbs, confirmDiscardChanges, dirty, navigate, server?.uuidShort]);
  const triggerExpand = useCallback((open: boolean) => {
    setExpandSignal((current) => ({ id: (current?.id ?? 0) + 1, open }));
  }, []);

  const readPath = useCallback((targetFile: string) => {
    if (!server?.uuid || !targetFile.trim()) return;
    setLoading(true);
    readNbtFile(server.uuid, targetFile, edition as 'auto' | 'java' | 'bedrock')
      .then((next) => {
        setResult(next);
        setDirty(false);
        triggerExpand(false);
      })
      .catch((error) => addToast(httpErrorToHuman(error), 'error'))
      .finally(() => setLoading(false));
  }, [addToast, edition, server?.uuid, triggerExpand]);

  const read = useCallback(() => {
    if (!confirmDiscardChanges()) return;
    readPath(file);
  }, [confirmDiscardChanges, file, readPath]);

  useEffect(() => {
    if (!queryFile) return;
    if (result && result.file === queryFile) return;

    if (queryFile !== file && !confirmDiscardChanges()) {
      navigate(`?${createSearchParams({ file })}`, { replace: true });
      return;
    }

    if (queryFile !== file && dirty) {
      setDirty(false);
    }

    setFile(queryFile);
    readPath(queryFile);
  }, [confirmDiscardChanges, dirty, file, navigate, queryFile, readPath, result]);

  const updateValue = useCallback((path: NbtPath, value: string) => {
    setResult((current) => {
      if (!current) return current;
      setDirty(true);
      const next = {
        ...current,
        parsed: {
          ...current.parsed,
          root: cloneNodeWithValue(current.parsed.root, path, value),
        },
      };
      resultRef.current = next;
      return next;
    });
  }, []);

  const save = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    const currentResult = resultRef.current;
    if (!server?.uuid || !currentResult || !dirty) return;
    setSaving(true);
    saveNbtFile(server.uuid, currentResult.file, currentResult.parsed)
      .then(() => {
        setDirty(false);
        addToast('NBT file saved.', 'success');
      })
      .catch((error) => addToast(httpErrorToHuman(error), 'error'))
      .finally(() => setSaving(false));
  }, [addToast, dirty, server?.uuid]);

  const revert = useCallback(() => {
    if (result) readPath(result.file);
  }, [readPath, result]);

  const openFiles = useCallback(() => {
    if (!server?.uuidShort || !confirmDiscardChanges()) return;
    const to = `/server/${server.uuidShort}/files`;
    if (dirty) {
      setDirty(false);
      window.setTimeout(() => navigate(to), 0);
      return;
    }

    navigate(to);
  }, [confirmDiscardChanges, dirty, navigate, server?.uuidShort]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    };

    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [save]);

  useEffect(() => {
    const listener = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', listener);
    return () => window.removeEventListener('beforeunload', listener);
  }, [dirty]);

  return (
    <ServerContentContainer title='NBT Editor' hideTitleComponent>
      <Stack gap={isMobile ? 'xs' : 'sm'}>
        <ConfirmationModal
          title='Unsaved changes'
          opened={blocker.state === 'blocked'}
          onClose={() => blocker.reset()}
          onConfirmed={() => blocker.proceed()}
          confirm='Leave page'
        >
          You have unsaved NBT changes. Save before leaving if you want to keep them.
        </ConfirmationModal>

        <Group justify='space-between' align='flex-start' wrap='wrap'>
          <Stack gap={4} style={{ flex: isMobile ? '1 0 100%' : undefined, minWidth: 0 }}>
            <Group gap='xs'>
              <FontAwesomeIcon icon={faFileCode} style={{ opacity: 0.75 }} />
              <Title order={isMobile ? 3 : 2} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Editing {fileName || 'NBT file'}
              </Title>
            </Group>
            <Group gap={6} wrap='nowrap' style={{ overflowX: 'auto', maxWidth: '100%' }}>
              {breadcrumbs.length > 0 ? (
                breadcrumbs.map((part, index) => (
                  <Group key={`${part}-${index}`} gap={6} wrap='nowrap' style={{ flex: '0 0 auto' }}>
                    {index > 0 ? (
                      <Text size='sm' c='dimmed'>
                        /
                      </Text>
                    ) : null}
                    {index === breadcrumbs.length - 1 ? (
                      <Text size='sm'>{part}</Text>
                    ) : (
                      <button
                        type='button'
                        onClick={() => openBreadcrumb(index)}
                        style={{
                          border: 0,
                          padding: 0,
                          background: 'transparent',
                          color: 'var(--mantine-color-blue-5)',
                          cursor: 'pointer',
                          font: 'inherit',
                          fontSize: 'var(--mantine-font-size-sm)',
                          lineHeight: 1.55,
                        }}
                      >
                        {part}
                      </button>
                    )}
                  </Group>
                ))
              ) : (
                <Text size='sm' c='dimmed'>
                  No file selected
                </Text>
              )}
            </Group>
          </Stack>
          <Group gap='xs' grow={isMobile} style={{ width: isMobile ? '100%' : undefined }}>
            <Button
              loading={saving}
              disabled={!dirty || !result}
              onClick={save}
              leftSection={<FontAwesomeIcon icon={faSave} />}
              style={{ minHeight: isMobile ? 48 : undefined }}
            >
              Save
            </Button>
            {!isMobile && saveStatus ? (
              <Text size='xs' c={dirty ? 'yellow' : 'dimmed'} style={{ minWidth: 92, whiteSpace: 'nowrap' }}>
                {saveStatus}
              </Text>
            ) : null}
            {!isMobile ? (
              <Select
                data={editionOptions}
                value={edition}
                onChange={(value) => {
                  if (!confirmDiscardChanges()) return;
                  setEdition(value ?? 'auto');
                }}
                style={{ width: 150 }}
              />
            ) : null}
            <Button
              variant='light'
              loading={loading}
              onClick={read}
              leftSection={<FontAwesomeIcon icon={faRotateRight} />}
              style={{ minHeight: isMobile ? 48 : undefined }}
            >
              Reload
            </Button>
            <Button
              variant='light'
              disabled={!server?.uuidShort}
              onClick={openFiles}
              leftSection={<FontAwesomeIcon icon={faFolderOpen} />}
              style={{ minHeight: isMobile ? 48 : undefined }}
            >
              Files
            </Button>
          </Group>
          {isMobile ? (
            <Select
              data={editionOptions}
              value={edition}
              onChange={(value) => {
                if (!confirmDiscardChanges()) return;
                setEdition(value ?? 'auto');
              }}
              style={{ width: '100%' }}
            />
          ) : null}
          {isMobile && saveStatus ? (
            <Text size='xs' c={dirty ? 'yellow' : 'dimmed'} style={{ width: '100%', textAlign: 'center' }}>
              {saveStatus}
            </Text>
          ) : null}
        </Group>

        {loading && !result ? (
          <LoadingPanel />
        ) : result ? (
          <ResultPanel
            parsed={result.parsed}
            query={query}
            deferredQuery={deferredQuery}
            dirty={dirty}
            expandSignal={expandSignal}
            isMobile={isMobile}
            onQueryChange={setQuery}
            onExpandAll={() => triggerExpand(true)}
            onCollapseAll={() => triggerExpand(false)}
            onRevert={revert}
            onChange={updateValue}
            setDirty={setDirty}
          />
        ) : (
          <Alert color='gray' title='No file open'>
            Choose a .dat or .nbt file from the file manager.
          </Alert>
        )}
      </Stack>
    </ServerContentContainer>
  );
}
