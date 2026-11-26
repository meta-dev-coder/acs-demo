/**
 * One Autodesk Viewer instance and the one model it shows. DOM-free apart from the container it is
 * handed, so the lifecycle (initialize once, load, switch, dispose) is unit-tested with a stand-in
 * `Autodesk` object.
 *
 * - One model at a time: every model is unloaded before the next one loads, and a load that
 *   finishes after a newer request started is unloaded instead of shown (no duplicate geometry).
 * - Clicking a body-geometry node selects the IFC element that owns it, so selection always lands
 *   on something with an IFC GlobalId.
 * - `dispose()` finishes the viewer and releases its WebGL context; a new session can be created on
 *   the same container afterwards.
 */

/** Autodesk.Viewing.ErrorCodes → the explorer's own codes (kept numeric so a stand-in can use them). */
const LOAD_ERRORS = {
  3: ['NETWORK', 'The derivative could not be downloaded.'],
  4: ['AUTH', 'Autodesk refused the viewer token (expired, or no access to this model).'],
  5: ['NO_DERIVATIVE', 'The derivative was not found. It may have been deleted.'],
  6: ['NETWORK', 'Autodesk returned a server error for the derivative.'],
  8: ['WEBGL', 'This browser cannot run the Autodesk Viewer (WebGL is not available).'],
  9: ['NO_GEOMETRY', 'The derivative contains no viewable geometry.'],
};

export class ViewerError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail ?? null;
  }
}

let initializedEnv = null;
/** Autodesk.Viewing.Initializer runs once per environment; a different one is shut down first. */
function initialize(Autodesk, { env, api, getAccessToken }) {
  const key = `${env}|${api}`;
  if (initializedEnv === key) return Promise.resolve();
  if (initializedEnv) Autodesk.Viewing.shutdown?.();
  return new Promise(resolve => {
    Autodesk.Viewing.Initializer({ env, api, getAccessToken }, () => { initializedEnv = key; resolve(); });
  });
}
/** For tests: forget the module-level initialization. */
export const resetViewerInitialization = () => { initializedEnv = null; };

export function createViewerSession({ Autodesk, container, getAccessToken, onSelect = () => {}, theme = 'light' }) {
  let viewer = null;
  let model = null;
  let generation = 0;
  let disposed = false;
  let tree = null;
  let resolvingSelection = false;
  const V = Autodesk.Viewing;

  function onSelection(event) {
    if (resolvingSelection) return;
    const dbId = (event?.dbIdArray ?? [])[0];
    if (dbId === undefined) { onSelect(null); return; }
    const element = owningElement(dbId);
    if (element !== dbId) {
      // A body representation was clicked: select its element instead (one more event follows).
      resolvingSelection = true;
      viewer.select([element]);
      resolvingSelection = false;
    }
    onSelect(element);
  }

  /** The element a node belongs to: itself, or its nearest ancestor that is an IFC element. */
  let isElement = () => true;
  function owningElement(dbId) {
    if (!tree) return dbId;
    let current = dbId;
    for (let depth = 0; depth < 12 && current; depth += 1) {
      if (isElement(current)) return current;
      current = tree.getNodeParentId(current);
    }
    return dbId;
  }

  function ensureViewer() {
    if (viewer) return viewer;
    viewer = new V.GuiViewer3D(container, { extensions: [], theme: theme === 'dark' ? 'dark-theme' : 'light-theme' });
    const code = viewer.start();
    if (code && code > 0) {
      viewer = null;
      throw new ViewerError(code === 8 ? 'WEBGL' : 'VIEWER_START', LOAD_ERRORS[code]?.[1] ?? `The Autodesk Viewer did not start (code ${code}).`);
    }
    viewer.setTheme?.(theme === 'dark' ? 'dark-theme' : 'light-theme');
    viewer.addEventListener(V.SELECTION_CHANGED_EVENT, onSelection);
    return viewer;
  }

  function unloadAll() {
    if (!viewer) return;
    for (const loaded of viewer.getAllModels?.() ?? (viewer.model ? [viewer.model] : [])) viewer.unloadModel(loaded);
    model = null;
    tree = null;
  }

  const loadDocument = urn => new Promise((resolve, reject) => {
    V.Document.load(`urn:${urn}`, resolve, (code, message) => {
      const [kind, text] = LOAD_ERRORS[code] ?? ['LOAD_FAILED', `The model could not be loaded (code ${code}).`];
      reject(new ViewerError(kind, text, message));
    });
  });

  const objectTree = loaded => new Promise((resolve, reject) => {
    loaded.getObjectTree(resolve, () => reject(new ViewerError('NO_TREE', 'The model has no object tree (property database missing).')));
  });

  /**
   * Show one viewable ({urn, env, api} from viewableOf). Resolves with `{model, tree}` once the
   * object tree is available, or `null` when a newer open() superseded this one.
   */
  async function open(viewable, { elementTest } = {}) {
    if (disposed) throw new ViewerError('DISPOSED', 'The viewer was closed.');
    const mine = ++generation;
    await initialize(Autodesk, { env: viewable.env, api: viewable.api, getAccessToken });
    if (mine !== generation || disposed) return null;
    ensureViewer();
    unloadAll();
    const doc = await loadDocument(viewable.urn);
    if (mine !== generation || disposed) return null;
    const node = doc.getRoot().getDefaultGeometry();
    if (!node) throw new ViewerError('NO_GEOMETRY', 'The derivative contains no 3D viewable.');
    const loaded = await viewer.loadDocumentNode(doc, node, { keepCurrentModels: false });
    if (mine !== generation || disposed) { viewer?.unloadModel(loaded); return null; }
    model = loaded;
    tree = await objectTree(loaded);
    if (mine !== generation || disposed) return null;
    if (elementTest) isElement = elementTest;
    return { model, tree };
  }

  const requireModel = () => { if (!model) throw new ViewerError('NO_MODEL', 'No model is loaded.'); return model; };

  return {
    open,
    /** Every property of the given nodes, as the viewer's property database holds them. */
    bulkProperties: dbIds => new Promise((resolve, reject) => {
      requireModel().getBulkProperties(dbIds, {}, resolve, error => reject(new ViewerError('PROPERTIES', 'Properties could not be read.', error?.message ?? String(error))));
    }),
    properties: dbId => new Promise((resolve, reject) => {
      requireModel().getProperties(dbId, resolve, error => reject(new ViewerError('PROPERTIES', 'Properties could not be read.', error?.message ?? String(error))));
    }),
    select: dbIds => {
      if (!viewer || !model) return;
      resolvingSelection = true;
      viewer.select(dbIds);
      resolvingSelection = false;
    },
    fit: dbIds => viewer?.fitToView(dbIds?.length ? dbIds : undefined),
    isolate: dbIds => viewer?.isolate(dbIds),
    showAll: () => viewer?.showAll(),
    reset: () => { viewer?.showAll(); viewer?.clearSelection(); viewer?.setViewFromFile?.() ?? viewer?.navigation?.setRequestHomeView?.(true); viewer?.fitToView(); },
    setTheme: name => viewer?.setTheme?.(name === 'dark' ? 'dark-theme' : 'light-theme'),
    resize: () => viewer?.resize(),
    tree: () => tree,
    modelCount: () => viewer?.getAllModels?.().length ?? (viewer?.model ? 1 : 0),
    selection: () => viewer?.getSelection?.() ?? [],
    get viewer() { return viewer; },
    dispose() {
      disposed = true;
      generation += 1;
      if (!viewer) return;
      viewer.removeEventListener(V.SELECTION_CHANGED_EVENT, onSelection);
      unloadAll();
      viewer.finish();
      viewer = null;
    },
  };
}
