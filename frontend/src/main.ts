import './styles.css';
import { deleteJson, fetchJson, postForm, postJson } from './api';
import { getClinicalReview, renderClinicalReview, renderPatientReport, saveClinicalReview } from './clinical_demo';
import DOMPurify from 'dompurify';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Archive,
  Bot,
  Boxes,
  ChevronLeft,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  File,
  FolderTree,
  Gauge,
  GitBranch,
  HardDriveUpload,
  Info,
  Loader2,
  Network,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  Upload,
  X,
  XCircle,
  type IconNode,
} from 'lucide';
import { marked } from 'marked';
import type { Bootstrap, FileTreeNode, JsonMap } from './types';

const state = {
  bootstrap: null as Bootstrap | null,
  busy: false,
  selectedNodeType: null as string | null,
  pendingParts: [] as JsonMap[],
  loadingMessage: null as JsonMap | null,
  transcriptScope: 'all',
  leftCollapsed: window.innerWidth <= 820,
  rightCollapsed: window.innerWidth <= 1180,
  view: ((window.location.pathname === '/knowledge-graph'
    ? 'knowledgeGraph'
    : window.location.pathname === '/chain-summary'
    ? 'chainSummary'
    : window.location.pathname === '/ecg-samples'
    ? 'ecgSamples'
    : window.location.pathname === '/patient'
    ? 'patient'
    : window.location.pathname === '/image-viewer'
    ? 'imageViewer'
    : window.location.pathname === '/settings'
    ? 'settings'
    : 'chat') as 'chat' | 'knowledgeGraph' | 'chainSummary' | 'ecgSamples' | 'patient' | 'imageViewer' | 'settings'),
  selectedImagePath: new URLSearchParams(window.location.search).get('path') || '',
  selectedGraphNodeId: null as string | null,
  knowledgeGraphTab: 'graph' as 'graph' | 'trace',
  graphInfoCollapsed: false,
  chainNavCollapsed: false,
  selectedKnowledgeBaseKind: null as string | null,
  knowledgeBaseCards: null as JsonMap | null,
  knowledgeBaseCardsBusy: false,
  expandedToolPartIds: new Set<string>(),
  settings: {
    iterativeK: 3,
    graphDepth: 2,
    graphAuthMode: 'manual',
    graphProtocol: '',
    graphModel: '',
    graphBaseUrl: '',
    graphApiKey: '',
    mainAuthMode: 'manual',
    mainProtocol: '',
    mainModel: '',
    mainBaseUrl: '',
    mainApiKey: '',
  } as {
    iterativeK: number;
    graphDepth: number;
    graphAuthMode: string;
    graphProtocol: string;
    graphModel: string;
    graphBaseUrl: string;
    graphApiKey: string;
    mainAuthMode: string;
    mainProtocol: string;
    mainModel: string;
    mainBaseUrl: string;
    mainApiKey: string;
  },
  settingsSaveTimer: 0,
  knowledgeQuestion: '',
  knowledgeAnswer: null as JsonMap | null,
  knowledgeQueryBusy: false,
  chainStatusSignature: '',
  chainChartSignature: '',
  chainContentSignature: '',
  ecgOverview: null as JsonMap | null,
  ecgDatasets: [] as JsonMap[],
  ecgDatasetKey: '',
  ecgWaveform: null as JsonMap | null,
  ecgBusy: false,
  ecgError: '',
  ecgStatus: 'errors' as 'all' | 'errors' | 'correct',
  ecgLabel: '',
  selectedEcgId: null as number | null,
  patientOverview: null as JsonMap | null,
  patientSampleId: null as number | null,
  patientBusy: false,
  patientError: '',
  patientMessages: [] as Array<{ role: 'user' | 'assistant'; text: string; source?: 'llm' | 'safety' | 'error' }>,
  patientQaBusy: false,
  patientQaRequestId: 0,
  renderSignatures: new Map<string, string>(),
  realtimeWaiters: [] as Array<{
    predicate: (data: Bootstrap) => boolean;
    resolve: (data: Bootstrap) => void;
    reject: (error: Error) => void;
    timer: number | null;
  }>,
};

marked.setOptions({
  breaks: true,
  gfm: true,
});

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app root');

app.innerHTML = `
  <button id="leftRailToggle" class="rail-toggle left-toggle" type="button" title="Collapse left sidebar"><span data-icon="ChevronLeft"></span></button>
  <button id="rightRailToggle" class="rail-toggle right-toggle" type="button" title="Collapse right sidebar"><span data-icon="ChevronRight"></span></button>

  <aside class="left-rail">
    <section class="brand-block">
      <div class="brand-mark" data-icon="Sparkles"></div>
      <div>
        <h1>HarnessingTS</h1>
        <p>Time-Series Agent Workbench</p>
      </div>
    </section>

    <div class="main-left-content">
    <section class="panel status-panel">
      <div class="panel-heading">
        <span data-icon="Gauge"></span>
        <span>Workspace</span>
      </div>
      <dl class="kv">
        <dt>Status</dt>
        <dd id="statusText">Loading</dd>
        <dt>Mode</dt>
        <dd id="modeText">-</dd>
        <dt>Workflow</dt>
        <dd id="variantText">-</dd>
        <dt>Model</dt>
        <dd id="modelText">-</dd>
        <dt>Environment</dt>
        <dd id="runtimeUvText">-</dd>
      </dl>
      <button id="settingsBtn" type="button" class="workspace-settings-btn"><span data-icon="SlidersHorizontal"></span><span>Workspace settings</span></button>
    </section>

    <section id="pendingControlPanel" class="panel control-panel" hidden>
      <div class="panel-heading">
        <span data-icon="ShieldCheck"></span>
        <span>Awaiting approval</span>
      </div>
      <div id="pendingControlBody" class="control-body"></div>
      <div class="split-actions">
        <button id="approveControlBtn" type="button" class="success-btn"><span data-icon="Check"></span><span>Approve</span></button>
        <button id="rejectControlBtn" type="button" class="danger ghost"><span data-icon="X"></span><span>Reject</span></button>
      </div>
    </section>

    <section class="panel">
      <div class="panel-heading">
        <span data-icon="GitBranch"></span>
        <span>Workflow stages</span>
      </div>
      <div id="nodeList" class="node-list"></div>
    </section>

    <section class="panel">
      <div class="panel-heading">
        <span data-icon="Boxes"></span>
        <span>Current stage</span>
      </div>
      <div id="nodeDetail" class="node-detail"></div>
    </section>

    <details class="panel timeline-panel">
      <summary class="panel-heading">
        <span data-icon="Clock3"></span>
        <span>Timeline</span>
      </summary>
      <div id="timeline" class="timeline"></div>
    </details>
    </div>

    <div class="graph-left-content">
      <section class="panel graph-control-card">
        <div class="panel-heading">
          <span data-icon="Settings2"></span>
          <span>Build settings</span>
        </div>
        <div id="graphBuildStatus" class="graph-build-status"></div>
        <div id="graphLeftActions" class="graph-left-actions">
          <button id="buildGraphBtn" type="button"><span data-icon="RefreshCw"></span><span>Build</span></button>
          <button id="rebuildGraphBtn" type="button" class="rebuild" hidden><span data-icon="RotateCcw"></span><span>Rebuild</span></button>
          <button id="continueGraphBtn" type="button" class="secondary"><span data-icon="Play"></span><span>Continue</span></button>
          <button id="pauseGraphBtn" type="button" class="danger ghost"><span data-icon="Pause"></span><span>Pause</span></button>
        </div>
      </section>

      <details class="panel graph-settings-card">
        <summary class="panel-heading">
          <span data-icon="SlidersHorizontal"></span>
          <span>Advanced settings</span>
        </summary>
        <div class="graph-settings-body">
        <label>
          <span>Extraction depth</span>
          <input id="graphExtractionDepthInput" type="number" min="1" max="4" step="1" />
        </label>
        <label>
          <span>Authentication</span>
          <select id="graphAuthMode">
            <option value="manual">Manual configuration</option>
            <option value="sdk-default">SDK default</option>
          </select>
        </label>
        <label>
          <span>Protocol</span>
          <select id="graphProtocol">
            <option value="">Auto</option>
            <option value="deepseek">deepseek</option>
            <option value="openai-compat">openai-compat</option>
          </select>
        </label>
        <label>
          <span>Model</span>
          <input id="graphModelInput" type="text" placeholder="Inherit primary model" />
        </label>
        <label>
          <span>API base URL</span>
          <input id="graphBaseUrlInput" type="text" placeholder="Inherit primary API URL" />
        </label>
        <label>
          <span>API key</span>
          <input id="graphApiKeyInput" type="password" placeholder="Leave blank to keep the current key" />
        </label>
        <button id="saveGraphLlmBtn" type="button" class="secondary full-width"><span data-icon="Check"></span><span>Save graph model</span></button>
        </div>
      </details>

      <section class="panel">
        <div class="panel-heading">
          <span data-icon="Gauge"></span>
          <span>Knowledge base</span>
        </div>
        <div class="knowledge-summary" id="knowledgeSummary"></div>
        <div class="knowledge-card-list" id="knowledgeCards"></div>
      </section>
    </div>
  </aside>

  <main class="main-pane">
    <header class="toolbar">
      <div class="toolbar-main">
        <div class="title-group">
          <div class="eyebrow"><span data-icon="Bot"></span><span>Main session</span></div>
          <h2 id="mainTitle">Task orchestration</h2>
        </div>
        <label class="transcript-filter">
          <span>Transcript scope</span>
          <select id="transcriptScope"></select>
        </label>
      </div>
      <div class="toolbar-actions">
        <button id="resetChatBtn" type="button" class="ghost debug-only"><span data-icon="RefreshCw"></span><span>Reset conversation</span></button>
        <button id="clearAllLogsBtn" type="button" class="danger ghost debug-only"><span data-icon="Trash2"></span><span>Reset workspace</span></button>
      </div>
    </header>

    <section id="chatStream" class="chat-stream"></section>
    <button id="chatTopBtn" type="button" class="chat-top-btn" title="Back to top" aria-label="Back to top"><span data-icon="ArrowUp"></span></button>

    <section id="settingsView" class="settings-view" hidden>
      <header class="settings-header">
        <div class="settings-header-inner">
          <div class="settings-header-text">
            <div class="settings-eyebrow"><span data-icon="SlidersHorizontal"></span><span>Workspace</span></div>
            <h1 class="settings-title">Settings</h1>
            <p class="settings-subtitle">Manage runtime settings and model configuration for this workspace. Some changes take effect immediately; others apply to the next message.</p>
          </div>
          <div class="settings-header-actions">
            <button id="settingsDoneBtn" type="button" class="settings-done-btn"><span data-icon="ChevronLeft"></span><span>Back to main session</span></button>
          </div>
        </div>
      </header>
      <div id="settingsContent" class="settings-content"></div>
    </section>
    <section id="knowledgeGraphView" class="knowledge-graph-view" hidden>
      <div class="graph-header">
        <div class="graph-title-block">
          <div class="eyebrow"><span data-icon="Network"></span><span>Knowledge graph</span></div>
          <h2 id="graphTitle">Reference knowledge</h2>
        </div>
        <div class="graph-header-actions">
          <button id="backToChatBtn" type="button" class="graph-back-button"><span data-icon="ChevronLeft"></span><span>Back to main session</span></button>
        </div>
      </div>
      <nav class="graph-tabs" aria-label="Knowledge graph views">
        <button id="graphTabTrace" type="button" class="graph-tab" data-graph-tab="trace"><span data-icon="TerminalSquare"></span><span>Build process</span></button>
        <button id="graphTabGraph" type="button" class="graph-tab active" data-graph-tab="graph"><span data-icon="Network"></span><span>Knowledge graph</span></button>
      </nav>
      <div id="graphTracePanel" class="graph-tab-panel graph-trace-panel" hidden>
        <section class="builder-trace-panel">
          <div class="panel-heading">
            <span data-icon="TerminalSquare"></span>
            <span>Build history</span>
          </div>
          <div id="builderTrace" class="builder-trace"></div>
        </section>
      </div>
      <div id="graphKnowledgePanel" class="graph-tab-panel graph-knowledge-panel">
        <div id="graphLayout" class="graph-layout">
          <div id="graphCanvas" class="graph-canvas"></div>
          <button id="graphInfoToggle" class="graph-info-toggle" type="button" title="Collapse graph details"><span data-icon="ChevronRight"></span></button>
          <aside id="graphInfoPanel" class="graph-inspector-shell">
            <header class="graph-inspector-header">
              <span data-icon="Info"></span>
              <span>Graph details</span>
            </header>
            <section id="graphInspector" class="graph-inspector"></section>
          </aside>
        </div>
      </div>
    </section>

    <section id="chainSummaryView" class="chain-summary-view" hidden>
      <header class="chain-header">
        <div class="chain-title-block">
          <div class="eyebrow"><span data-icon="Activity"></span><span>Workflow summary</span></div>
          <h2>Workflow summary</h2>
          <p>Trace the decisions behind each iteration using logs, reports, results, and case evidence.</p>
        </div>
        <div class="chain-header-actions">
          <button id="backToChatFromChainBtn" type="button" class="chain-back-btn"><span data-icon="ChevronLeft"></span><span>Back to main session</span></button>
          <button id="buildChainSummaryBtn" type="button" class="chain-generate-btn"><span data-icon="RefreshCw"></span><span>Generate workflow summary</span></button>
        </div>
      </header>
      <div id="chainBody" class="chain-body">
        <button id="chainNavToggle" class="chain-nav-toggle" type="button" title="Collapse contents"><span data-icon="ChevronLeft"></span></button>
        <aside id="chainNav" class="chain-nav">
          <div class="chain-nav-heading"><span data-icon="GitBranch"></span><span>Contents</span></div>
          <nav id="chainNavContent" class="chain-nav-content" aria-label="Workflow summary sections"></nav>
        </aside>
        <div id="chainMainScroll" class="chain-main-scroll">
          <section id="chainBuildStatus" class="chain-build-status chain-anchor"></section>
          <section id="chainMetricChart" class="chain-chart-panel"></section>
          <section id="chainSummaryContent" class="chain-content-panel"></section>
        </div>
      </div>
    </section>

    <section id="ecgSamplesView" class="ecg-samples-view" hidden>
      <header class="ecg-header">
        <div>
          <div class="eyebrow"><span data-icon="Activity"></span><span>Current dataset</span></div>
          <h2>ECG Case Explorer</h2>
          <p id="ecgWorkspaceMeta">Loading latest experiment results</p>
        </div>
        <div class="ecg-header-actions">
          <a href="/demo" class="secondary" style="text-decoration:none;padding:10px 12px">Interactive Demo</a>
          <button id="openPatientFromEcgBtn" type="button" class="secondary"><span data-icon="File"></span><span>Patient preview</span></button>
          <button id="refreshEcgBtn" type="button" class="secondary"><span data-icon="RefreshCw"></span><span>Refresh</span></button>
          <button id="backToChatFromEcgBtn" type="button" class="graph-back-button"><span data-icon="ChevronLeft"></span><span>Back to main session</span></button>
        </div>
      </header>
      <section id="ecgMetricStrip" class="ecg-metric-strip"></section>
      <div class="ecg-controls">
        <label>Dataset
          <select id="ecgDatasetSelect"></select>
        </label>
        <label>Case status
          <select id="ecgStatusFilter">
            <option value="errors">Error cases</option>
            <option value="all">All cases</option>
            <option value="correct">Correct cases</option>
          </select>
        </label>
        <label>Class
          <select id="ecgLabelFilter">
            <option value="">All classes</option>
            <option value="NORM">NORM</option>
            <option value="MI">MI</option>
            <option value="STTC">STTC</option>
            <option value="CD">CD</option>
            <option value="HYP">HYP</option>
          </select>
        </label>
        <span id="ecgMatchCount" class="ecg-match-count"></span>
      </div>
      <div id="ecgEmptyState" class="ecg-empty-state" hidden></div>
      <div id="ecgWorkbench" class="ecg-workbench" hidden>
        <aside class="ecg-sample-browser">
          <div class="ecg-pane-title">Case</div>
          <div id="ecgSampleList" class="ecg-sample-list"></div>
        </aside>
        <section class="ecg-waveform-pane">
          <div id="ecgWaveformHeading" class="ecg-pane-title">12-lead ECG</div>
          <div id="ecgWaveformGrid" class="ecg-waveform-grid"></div>
        </section>
        <aside class="ecg-result-pane">
          <div class="ecg-pane-title">Classification results</div>
          <div id="ecgResultDetail"></div>
          <div id="clinicalReviewPane" class="clinical-review-pane"></div>
        </aside>
      </div>
    </section>

    <section id="patientView" class="patient-view" hidden>
      <header class="patient-header">
        <div><div class="eyebrow"><span data-icon="File"></span><span>Patient view</span></div><h2>My ECG Report</h2><p>Explore a public dataset case. This is a demonstration, not personal medical care.</p></div>
        <button id="backToEcgFromPatientBtn" type="button" class="secondary"><span data-icon="ChevronLeft"></span><span>Back to ECG cases</span></button>
      </header>
      <div class="patient-toolbar"><label for="patientSampleSelect">Demo case</label><select id="patientSampleSelect"></select><span id="patientDatasetName"></span></div>
      <div id="patientEmptyState" class="patient-empty-state" hidden></div>
      <div id="patientContent" class="patient-content" hidden>
        <section class="patient-report"><div class="patient-section-heading"><span data-icon="File"></span><span>Report</span></div><div id="patientReportBody"></div></section>
        <section class="patient-qa"><div class="patient-section-heading"><span data-icon="Bot"></span><span>Report Q&A</span><small>AI-assisted</small></div><div id="patientQaMessages" class="patient-qa-messages"></div><form id="patientQaForm"><label class="sr-only-file" for="patientQuestion">Ask a question</label><input id="patientQuestion" maxlength="300" placeholder="For example: What does this result mean?" required /><button type="submit"><span data-icon="Send"></span><span>Ask</span></button></form><p class="patient-qa-note">Your question, this case's model predictions, and any locally saved review labels are sent to the configured LLM. Answers are educational, not medical advice.</p></section>
      </div>
    </section>

    <section id="imageViewerView" class="image-viewer-view" hidden>
      <header class="image-viewer-header">
        <div>
          <div class="eyebrow"><span data-icon="Activity"></span><span>Summary figure</span></div>
          <h2 id="imageViewerTitle">Case visualization</h2>
        </div>
        <button id="backToChainFromImageBtn" type="button" class="chain-back-btn"><span data-icon="ChevronLeft"></span><span>Back to workflow summary</span></button>
      </header>
      <section class="image-viewer-stage">
        <img id="imageViewerImage" alt="Workflow summary image" />
      </section>
      <div id="imageViewerPath" class="image-viewer-path"></div>
    </section>

    <form id="sendForm" class="composer">
      <p id="pauseWaitHint" class="pause-wait-hint" role="status" hidden></p>
      <button id="forceStopBtn" type="button" class="danger ghost" hidden>Force stop</button>
      <div class="composer-shell">
        <textarea id="messageInput" rows="1" placeholder="Message the task orchestrator"></textarea>
        <button id="interruptBtn" type="button" class="composer-stop-btn" title="Pause response" hidden><span data-icon="Square"></span></button>
        <button id="sendBtn" type="submit" class="send-round" title="Send" disabled><span data-icon="ArrowUp"></span></button>
      </div>
    </form>
  </main>

  <aside class="right-rail">
    <button id="kgCta" class="kg-cta" type="button" data-state="idle" aria-label="Open knowledge graph">
      <div class="kg-cta-icon"><span data-icon="Network"></span></div>
      <div class="kg-cta-body">
        <div class="kg-cta-eyebrow">Reference knowledge</div>
        <div class="kg-cta-title">Knowledge graph</div>
        <div class="kg-cta-meta">
          <span class="kg-cta-pill" id="kgCtaPill">Idle</span>
          <span class="kg-cta-stats" id="kgCtaStats">Not built</span>
        </div>
      </div>
      <div class="kg-cta-arrow"><span data-icon="ChevronRight"></span></div>
    </button>
    <button id="chainCta" class="kg-cta chain-cta" type="button" data-state="idle" aria-label="Open workflow summary">
      <div class="kg-cta-icon"><span data-icon="Activity"></span></div>
      <div class="kg-cta-body">
        <div class="kg-cta-eyebrow">Execution trace</div>
        <div class="kg-cta-title">Workflow summary</div>
        <div class="kg-cta-meta">
          <span class="kg-cta-pill" id="chainCtaPill">Idle</span>
          <span class="kg-cta-stats" id="chainCtaStats">Not generated</span>
        </div>
      </div>
      <div class="kg-cta-arrow"><span data-icon="ChevronRight"></span></div>
    </button>
    <button id="ecgCta" class="kg-cta ecg-cta" type="button" data-state="ready" aria-label="Open ECG Case Explorer">
      <div class="kg-cta-icon"><span data-icon="Activity"></span></div>
      <div class="kg-cta-body">
        <div class="kg-cta-eyebrow">Classification results</div>
        <div class="kg-cta-title">ECG Case Explorer</div>
        <div class="kg-cta-meta"><span class="kg-cta-pill built">Live</span><span class="kg-cta-stats">Uses current workspace</span></div>
      </div>
      <div class="kg-cta-arrow"><span data-icon="ChevronRight"></span></div>
    </button>
    <button id="patientCta" class="kg-cta patient-cta" type="button" aria-label="Open patient view">
      <div class="kg-cta-icon"><span data-icon="File"></span></div><div class="kg-cta-body"><div class="kg-cta-eyebrow">Interactive demo</div><div class="kg-cta-title">Patient report and Q&A</div><div class="kg-cta-meta"><span class="kg-cta-stats">Local prototype · Not a diagnosis</span></div></div><div class="kg-cta-arrow"><span data-icon="ChevronRight"></span></div>
    </button>
    <section class="panel files-panel">
      <div class="panel-heading">
        <span data-icon="FolderTree"></span>
        <span>Workspace files</span>
      </div>
      <div id="workspacePath" class="workspace-path"></div>
      <div class="workspace-dataset-control">
        <label for="workspaceDatasetSelect">Current dataset</label>
        <select id="workspaceDatasetSelect"></select>
      </div>
      <form id="uploadForm" class="upload-form">
        <button id="uploadBtn" type="button" class="upload-pick-button">
          <span class="upload-pick-icon" data-icon="Upload"></span>
          <span class="upload-pick-copy">
            <span class="upload-pick-title">Upload reference files</span>
            <span class="upload-pick-subtitle">Select one or more files to upload</span>
          </span>
        </button>
        <input id="referenceFiles" class="sr-only-file" type="file" multiple />
      </form>
      <form id="rawZipUploadForm" class="upload-form">
        <button id="rawZipUploadBtn" type="button" class="upload-pick-button">
          <span class="upload-pick-icon" data-icon="HardDriveUpload"></span>
          <span class="upload-pick-copy">
            <span class="upload-pick-title">Import raw dataset ZIP</span>
            <span class="upload-pick-subtitle">Select a ZIP to extract into data/raw/</span>
          </span>
        </button>
        <input id="rawZipFile" class="sr-only-file" type="file" accept=".zip" />
      </form>
      <div id="fileTree" class="file-tree"></div>
    </section>
  </aside>

  <dialog id="detailDialog">
    <form method="dialog">
      <header>
        <h3 id="dialogTitle">Details</h3>
        <div class="dialog-actions">
          <button id="deleteReferenceBtn" value="" class="dialog-delete-btn" type="button" hidden><span data-icon="Trash2"></span><span>Delete reference</span></button>
          <button value="close" class="icon-btn ghost" type="submit" title="Close"><span data-icon="X"></span></button>
        </div>
      </header>
      <pre id="dialogBody"></pre>
    </form>
  </dialog>

`;

const iconMap: Record<string, IconNode> = {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Archive,
  Bot,
  Boxes,
  ChevronLeft,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  File,
  FolderTree,
  Gauge,
  GitBranch,
  HardDriveUpload,
  Info,
  Loader2,
  Network,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  Upload,
  X,
  XCircle,
};

const els = {
  leftRailToggle: query<HTMLButtonElement>('#leftRailToggle'),
  rightRailToggle: query<HTMLButtonElement>('#rightRailToggle'),
  statusText: query('#statusText'),
  modeText: query('#modeText'),
  variantText: query('#variantText'),
  modelText: query('#modelText'),
  runtimeUvText: query('#runtimeUvText'),
  pendingControlPanel: query<HTMLElement>('#pendingControlPanel'),
  pendingControlBody: query('#pendingControlBody'),
  approveControlBtn: query<HTMLButtonElement>('#approveControlBtn'),
  rejectControlBtn: query<HTMLButtonElement>('#rejectControlBtn'),
  nodeList: query('#nodeList'),
  nodeDetail: query('#nodeDetail'),
  chatStream: query<HTMLElement>('#chatStream'),
  chatTopBtn: query<HTMLButtonElement>('#chatTopBtn'),
  knowledgeGraphView: query<HTMLElement>('#knowledgeGraphView'),
  chainSummaryView: query<HTMLElement>('#chainSummaryView'),
  ecgSamplesView: query<HTMLElement>('#ecgSamplesView'),
  ecgWorkspaceMeta: query<HTMLElement>('#ecgWorkspaceMeta'),
  ecgMetricStrip: query<HTMLElement>('#ecgMetricStrip'),
  ecgDatasetSelect: query<HTMLSelectElement>('#ecgDatasetSelect'),
  ecgStatusFilter: query<HTMLSelectElement>('#ecgStatusFilter'),
  ecgLabelFilter: query<HTMLSelectElement>('#ecgLabelFilter'),
  ecgMatchCount: query<HTMLElement>('#ecgMatchCount'),
  ecgEmptyState: query<HTMLElement>('#ecgEmptyState'),
  ecgWorkbench: query<HTMLElement>('#ecgWorkbench'),
  ecgSampleList: query<HTMLElement>('#ecgSampleList'),
  ecgWaveformHeading: query<HTMLElement>('#ecgWaveformHeading'),
  ecgWaveformGrid: query<HTMLElement>('#ecgWaveformGrid'),
  ecgResultDetail: query<HTMLElement>('#ecgResultDetail'),
  clinicalReviewPane: query<HTMLElement>('#clinicalReviewPane'),
  refreshEcgBtn: query<HTMLButtonElement>('#refreshEcgBtn'),
  openPatientFromEcgBtn: query<HTMLButtonElement>('#openPatientFromEcgBtn'),
  backToChatFromEcgBtn: query<HTMLButtonElement>('#backToChatFromEcgBtn'),
  patientView: query<HTMLElement>('#patientView'),
  patientSampleSelect: query<HTMLSelectElement>('#patientSampleSelect'),
  patientDatasetName: query<HTMLElement>('#patientDatasetName'),
  patientEmptyState: query<HTMLElement>('#patientEmptyState'),
  patientContent: query<HTMLElement>('#patientContent'),
  patientReportBody: query<HTMLElement>('#patientReportBody'),
  patientQaMessages: query<HTMLElement>('#patientQaMessages'),
  patientQaForm: query<HTMLFormElement>('#patientQaForm'),
  patientQuestion: query<HTMLInputElement>('#patientQuestion'),
  backToEcgFromPatientBtn: query<HTMLButtonElement>('#backToEcgFromPatientBtn'),
  imageViewerView: query<HTMLElement>('#imageViewerView'),
  imageViewerTitle: query<HTMLElement>('#imageViewerTitle'),
  imageViewerImage: query<HTMLImageElement>('#imageViewerImage'),
  imageViewerPath: query<HTMLElement>('#imageViewerPath'),
  backToChainFromImageBtn: query<HTMLButtonElement>('#backToChainFromImageBtn'),
  backToChatFromChainBtn: query<HTMLButtonElement>('#backToChatFromChainBtn'),
  buildChainSummaryBtn: query<HTMLButtonElement>('#buildChainSummaryBtn'),
  chainBody: query<HTMLElement>('#chainBody'),
  chainNav: query<HTMLElement>('#chainNav'),
  chainNavToggle: query<HTMLButtonElement>('#chainNavToggle'),
  chainNavContent: query<HTMLElement>('#chainNavContent'),
  chainMainScroll: query<HTMLElement>('#chainMainScroll'),
  chainBuildStatus: query<HTMLElement>('#chainBuildStatus'),
  chainMetricChart: query<HTMLElement>('#chainMetricChart'),
  chainSummaryContent: query<HTMLElement>('#chainSummaryContent'),
  graphTitle: query('#graphTitle'),
  graphTabTrace: query<HTMLButtonElement>('#graphTabTrace'),
  graphTabGraph: query<HTMLButtonElement>('#graphTabGraph'),
  graphTracePanel: query<HTMLElement>('#graphTracePanel'),
  graphKnowledgePanel: query<HTMLElement>('#graphKnowledgePanel'),
  graphLayout: query<HTMLElement>('#graphLayout'),
  graphInfoPanel: query<HTMLElement>('#graphInfoPanel'),
  graphInfoToggle: query<HTMLButtonElement>('#graphInfoToggle'),
  graphCanvas: query('#graphCanvas'),
  graphInspector: query('#graphInspector'),
  graphBuildStatus: query('#graphBuildStatus'),
  graphLeftActions: query<HTMLElement>('#graphLeftActions'),
  graphAuthMode: query<HTMLSelectElement>('#graphAuthMode'),
  graphProtocol: query<HTMLSelectElement>('#graphProtocol'),
  graphModelInput: query<HTMLInputElement>('#graphModelInput'),
  graphApiKeyInput: query<HTMLInputElement>('#graphApiKeyInput'),
  graphBaseUrlInput: query<HTMLInputElement>('#graphBaseUrlInput'),
  graphExtractionDepthInput: query<HTMLInputElement>('#graphExtractionDepthInput'),
  saveGraphLlmBtn: query<HTMLButtonElement>('#saveGraphLlmBtn'),
  buildGraphBtn: query<HTMLButtonElement>('#buildGraphBtn'),
  rebuildGraphBtn: query<HTMLButtonElement>('#rebuildGraphBtn'),
  continueGraphBtn: query<HTMLButtonElement>('#continueGraphBtn'),
  pauseGraphBtn: query<HTMLButtonElement>('#pauseGraphBtn'),
  knowledgeSummary: query('#knowledgeSummary'),
  knowledgeCards: query('#knowledgeCards'),
  builderTrace: query('#builderTrace'),
  backToChatBtn: query<HTMLButtonElement>('#backToChatBtn'),
  transcriptScope: query<HTMLSelectElement>('#transcriptScope'),
  sendForm: query<HTMLFormElement>('#sendForm'),
  messageInput: query<HTMLTextAreaElement>('#messageInput'),
  sendBtn: query<HTMLButtonElement>('#sendBtn'),
  interruptBtn: query<HTMLButtonElement>('#interruptBtn'),
  pauseWaitHint: query<HTMLElement>('#pauseWaitHint'),
  forceStopBtn: query<HTMLButtonElement>('#forceStopBtn'),
  timeline: query('#timeline'),
  workspacePath: query('#workspacePath'),
  fileTree: query('#fileTree'),
  workspaceDatasetSelect: query<HTMLSelectElement>('#workspaceDatasetSelect'),
  uploadForm: query<HTMLFormElement>('#uploadForm'),
  referenceFiles: query<HTMLInputElement>('#referenceFiles'),
  uploadBtn: query<HTMLButtonElement>('#uploadBtn'),
  rawZipUploadForm: query<HTMLFormElement>('#rawZipUploadForm'),
  rawZipFile: query<HTMLInputElement>('#rawZipFile'),
  rawZipUploadBtn: query<HTMLButtonElement>('#rawZipUploadBtn'),
  kgCta: query<HTMLButtonElement>('#kgCta'),
  kgCtaPill: query<HTMLElement>('#kgCtaPill'),
  kgCtaStats: query<HTMLElement>('#kgCtaStats'),
  chainCta: query<HTMLButtonElement>('#chainCta'),
  chainCtaPill: query<HTMLElement>('#chainCtaPill'),
  chainCtaStats: query<HTMLElement>('#chainCtaStats'),
  ecgCta: query<HTMLButtonElement>('#ecgCta'),
  patientCta: query<HTMLButtonElement>('#patientCta'),
  settingsBtn: query<HTMLButtonElement>('#settingsBtn'),
  settingsView: query<HTMLElement>('#settingsView'),
  settingsContent: query<HTMLElement>('#settingsContent'),
  settingsDoneBtn: query<HTMLButtonElement>('#settingsDoneBtn'),
  resetChatBtn: query<HTMLButtonElement>('#resetChatBtn'),
  clearAllLogsBtn: query<HTMLButtonElement>('#clearAllLogsBtn'),
  dialog: query<HTMLDialogElement>('#detailDialog'),
  dialogTitle: query('#dialogTitle'),
  dialogBody: query('#dialogBody'),
  deleteReferenceBtn: query<HTMLButtonElement>('#deleteReferenceBtn'),
};

hydrateIcons();

els.leftRailToggle.addEventListener('click', () => {
  state.leftCollapsed = !state.leftCollapsed;
  renderShellState();
});
els.rightRailToggle.addEventListener('click', () => {
  state.rightCollapsed = !state.rightCollapsed;
  renderShellState();
});
els.messageInput.addEventListener('input', () => {
  autosizeComposer();
  updateSendButton();
});

// Track IME composition state locally. We need this because some mobile
// IMEs (e.g. iOS Chinese) commit the candidate and *then* fire the final
// Enter keydown with isComposing already false — by the time the keydown
// arrives the composition has ended, so a flag tracked via
// compositionstart / compositionend is the only reliable signal.
let imeActive = false;
els.messageInput.addEventListener('compositionstart', () => {
  imeActive = true;
});
els.messageInput.addEventListener('compositionend', () => {
  imeActive = false;
});
els.messageInput.addEventListener('keydown', (event) => {
  // An IME-processing Enter must never send. Four independent signals cover
  // the matrix of browsers and IMEs:
  //   1. event.isComposing  — modern Chromium / WebKit / Firefox (Chrome 66+,
  //      Firefox 68+, Safari 13+). True while a composition is active.
  //   2. event.keyCode === 229 — the legacy "IME processed" indicator that
  //      every browser still emits as a fallback (deprecated but universal).
  //   3. event.key === 'Process' — what older WebKit and some mobile IMEs
  //      set on the keydown of a key the IME consumed.
  //   4. imeActive — the composition-state flag tracked above, for the
  //      post-composition-end race on iOS Chinese / Korean keyboards.
  if (event.isComposing || event.keyCode === 229 || event.key === 'Process' || imeActive) return;
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (!els.sendBtn.disabled) els.sendForm.requestSubmit();
});
els.approveControlBtn.addEventListener('click', async () => {
  await runStreamingAction(async () => {
    await postJson('/api/control/approve', {});
  });
});
els.rejectControlBtn.addEventListener('click', async () => {
  const reason = els.messageInput.value.trim();
  await runAction(async () => {
    const result = await postJson('/api/control/reject', { reason: reason || 'Rejected from web UI.' });
    applyBootstrapSnapshot(result.bootstrap);
  });
});
els.transcriptScope.addEventListener('change', () => {
  state.transcriptScope = els.transcriptScope.value;
  render();
});
els.chatStream.addEventListener('scroll', updateChatTopButton);
els.chatTopBtn.addEventListener('click', () => {
  els.chatStream.scrollTo({ top: 0, behavior: 'smooth' });
});
els.backToChatBtn.addEventListener('click', () => {
  state.view = 'chat';
  history.pushState({}, '', '/');
  render();
});
els.settingsBtn.addEventListener('click', () => {
  state.view = 'settings';
  history.pushState({}, '', '/settings');
  render();
});
els.settingsDoneBtn.addEventListener('click', () => {
  state.view = 'chat';
  history.pushState({}, '', '/');
  render();
});
els.buildGraphBtn.addEventListener('click', async () => {
  await postJson('/api/knowledge-graph/build', { trigger: 'manual' });
});
els.rebuildGraphBtn.addEventListener('click', async () => {
  await postJson('/api/knowledge-graph/build', { trigger: 'rebuild' });
});
els.continueGraphBtn.addEventListener('click', async () => {
  await postJson('/api/knowledge-graph/continue', {});
});
els.pauseGraphBtn.addEventListener('click', async () => {
  await postJson('/api/knowledge-graph/pause', { reason: 'User paused from the knowledge graph view.' });
});
els.saveGraphLlmBtn.addEventListener('click', async () => {
  await saveKnowledgeGraphLlmConfig();
});
els.graphTabTrace.addEventListener('click', () => {
  state.knowledgeGraphTab = 'trace';
  renderKnowledgeGraphTabState();
});
els.graphTabGraph.addEventListener('click', () => {
  state.knowledgeGraphTab = 'graph';
  renderKnowledgeGraphTabState();
});
els.graphInfoToggle.addEventListener('click', () => {
  state.graphInfoCollapsed = !state.graphInfoCollapsed;
  renderGraphInfoState();
});
els.kgCta.addEventListener('click', async () => {
  state.view = 'knowledgeGraph';
  history.pushState({}, '', '/knowledge-graph');
  render();
});
els.chainCta.addEventListener('click', async () => {
  state.view = 'chainSummary';
  history.pushState({}, '', '/chain-summary');
  resetChainRenderSignatures();
  render();
});
els.ecgCta.addEventListener('click', () => {
  state.view = 'ecgSamples';
  history.pushState({}, '', '/ecg-samples');
  render();
  void loadEcgOverview();
});
function openPatientView(ecgId: number | null = null) {
  if (ecgId !== null) state.patientSampleId = ecgId;
  state.patientMessages = [];
  state.view = 'patient';
  history.pushState({}, '', '/patient');
  render();
  void loadPatientOverview();
}
els.patientCta.addEventListener('click', () => openPatientView());
els.openPatientFromEcgBtn.addEventListener('click', () => openPatientView(state.selectedEcgId));
els.backToEcgFromPatientBtn.addEventListener('click', () => {
  state.view = 'ecgSamples';
  history.pushState({}, '', '/ecg-samples');
  render();
  void loadEcgOverview();
});
els.backToChatFromEcgBtn.addEventListener('click', () => {
  state.view = 'chat';
  history.pushState({}, '', '/');
  render();
});
els.refreshEcgBtn.addEventListener('click', () => void loadEcgOverview(true));
els.workspaceDatasetSelect.addEventListener('change', () => {
  state.ecgDatasetKey = els.workspaceDatasetSelect.value;
  state.ecgOverview = null;
  state.patientOverview = null;
  state.ecgWaveform = null;
  state.selectedEcgId = null;
  renderWorkspaceDatasetControl();
  if (state.view === 'ecgSamples') void loadEcgOverview(true);
});
els.ecgDatasetSelect.addEventListener('change', () => {
  state.ecgDatasetKey = els.ecgDatasetSelect.value;
  state.ecgOverview = null;
  state.patientOverview = null;
  state.ecgWaveform = null;
  state.selectedEcgId = null;
  renderWorkspaceDatasetControl();
  void loadEcgOverview(true);
});
els.ecgStatusFilter.addEventListener('change', () => {
  state.ecgStatus = els.ecgStatusFilter.value as 'all' | 'errors' | 'correct';
  void loadEcgOverview(true);
});
els.ecgLabelFilter.addEventListener('change', () => {
  state.ecgLabel = els.ecgLabelFilter.value;
  void loadEcgOverview(true);
});
els.ecgSampleList.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-ecg-id]');
  if (!button) return;
  void selectEcgSample(Number(button.dataset.ecgId));
});
els.clinicalReviewPane.addEventListener('submit', (event) => {
  event.preventDefault();
  const sample = (state.ecgOverview?.samples || []).find((item: JsonMap) => Number(item.ecgId) === state.selectedEcgId);
  const form = event.target as HTMLFormElement;
  if (!sample || form.id !== 'clinicalReviewForm') return;
  const action = (event as SubmitEvent).submitter as HTMLButtonElement | null;
  const status = action?.dataset.reviewAction === 'approved' ? 'approved' : 'draft';
  const message = saveClinicalReview(state.ecgDatasetKey, Number(sample.ecgId), form, status);
  const messageNode = els.clinicalReviewPane.querySelector<HTMLElement>('#clinicalReviewMessage');
  if (messageNode) messageNode.textContent = message;
  if (message.startsWith('Review approved in this browser') || message.startsWith('Review draft saved in this browser')) {
    els.clinicalReviewPane.innerHTML = renderClinicalReview(sample, state.ecgDatasetKey);
    renderPatientDemo();
  }
});
els.patientSampleSelect.addEventListener('change', () => {
  state.patientSampleId = Number(els.patientSampleSelect.value);
  state.patientMessages = [];
  state.patientQaRequestId += 1;
  state.patientQaBusy = false;
  renderPatientDemo();
});
els.patientQaForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.patientQaBusy) return;
  const question = els.patientQuestion.value.trim();
  if (!question) return;
  const sample = (state.patientOverview?.samples || []).find((item: JsonMap) => Number(item.ecgId) === state.patientSampleId) || null;
  if (!sample || !state.ecgDatasetKey) return;
  const history = state.patientMessages.filter((message) => message.source !== 'error' && message.source !== 'safety').slice(-6);
  const dataset = state.ecgDatasetKey;
  const ecgId = Number(sample.ecgId);
  const review = getClinicalReview(dataset, ecgId);
  const reviewLabels = review?.status === 'approved' ? review.labels : [];
  const requestId = ++state.patientQaRequestId;
  state.patientQaBusy = true;
  state.patientMessages.push({ role: 'user', text: question });
  els.patientQuestion.value = '';
  renderPatientMessages();
  try {
    const result = await postJson<{ answer: string; source: 'llm' | 'safety' }>('/api/ecg/patient-qa', {
      dataset, ecgId, question, history, reviewLabels,
    });
    if (requestId !== state.patientQaRequestId) return;
    state.patientMessages.push({ role: 'assistant', text: result.answer, source: result.source });
  } catch (error) {
    if (requestId !== state.patientQaRequestId) return;
    state.patientMessages.push({ role: 'assistant', text: error instanceof Error ? error.message : 'AI answer unavailable. Please try again.', source: 'error' });
  } finally {
    if (requestId === state.patientQaRequestId) {
      state.patientQaBusy = false;
      renderPatientMessages();
    }
  }
});
els.backToChatFromChainBtn.addEventListener('click', () => {
  state.view = 'chat';
  history.pushState({}, '', '/');
  render();
});
els.backToChainFromImageBtn.addEventListener('click', () => {
  state.view = 'chainSummary';
  history.pushState({}, '', '/chain-summary');
  render();
});
els.buildChainSummaryBtn.addEventListener('click', async () => {
  resetChainRenderSignatures();
  await postJson('/api/chain-summary/build', {});
});
els.chainNavToggle.addEventListener('click', () => {
  state.chainNavCollapsed = !state.chainNavCollapsed;
  renderChainNavState();
});
window.addEventListener('popstate', () => {
  const path = window.location.pathname;
  state.view = path === '/knowledge-graph'
    ? 'knowledgeGraph'
    : path === '/chain-summary'
    ? 'chainSummary'
    : path === '/ecg-samples'
    ? 'ecgSamples'
    : path === '/patient'
    ? 'patient'
    : path === '/image-viewer'
    ? 'imageViewer'
    : path === '/settings'
    ? 'settings'
    : 'chat';
  state.selectedImagePath = path === '/image-viewer'
    ? new URLSearchParams(window.location.search).get('path') || ''
    : state.selectedImagePath;
  render();
  if (state.view === 'ecgSamples') void loadEcgOverview();
  if (state.view === 'patient') void loadPatientOverview();
});
els.graphExtractionDepthInput.addEventListener('change', async () => {
  await saveGraphExtractionDepth();
});
async function saveGraphExtractionDepth() {
  const value = Number.parseInt(els.graphExtractionDepthInput.value, 10);
  if (!Number.isFinite(value)) return;
  const result = await postJson('/api/runtime-settings', { knowledgeGraphExtractionDepth: value });
  applyBootstrapSnapshot(result.bootstrap);
}
async function saveKnowledgeGraphLlmConfig() {
  const result = await postJson('/api/knowledge-graph/llm-config', {
    authMode: els.graphAuthMode.value,
    protocol: els.graphProtocol.value || undefined,
    model: els.graphModelInput.value.trim(),
    apiKey: els.graphApiKeyInput.value.trim() || undefined,
    baseUrl: els.graphBaseUrlInput.value.trim(),
  });
  applyBootstrapSnapshot(result.bootstrap);
  els.graphApiKeyInput.value = '';
}
els.interruptBtn.addEventListener('click', async () => {
  const reason = els.messageInput.value.trim();
  await pauseCurrent(reason || 'User paused from web UI.');
});
els.forceStopBtn.addEventListener('click', async () => {
  if (!confirm('Force stopping can leave in-progress tool results unknown. Continue only if a normal pause is unresponsive. Continue?')) return;
  await postJson('/api/execution/force-stop', { confirm: true });
});
els.resetChatBtn.addEventListener('click', async () => {
  if (!confirm('Reset the conversation and agent workflow memory? Raw data, references, and the knowledge graph will be kept.')) return;
  await runAction(async () => {
    const result = await postJson('/api/debug/clear-logs', { scope: 'chat', confirmReset: true });
    state.pendingParts = [];
    state.loadingMessage = null;
    state.transcriptScope = 'main';
    state.renderSignatures.clear();
    applyBootstrapSnapshot(result.bootstrap);
  });
});
els.clearAllLogsBtn.addEventListener('click', async () => {
  if (!confirm('Reset this entire workspace? This deletes references, the knowledge graph, logs, run artifacts, reports, and temporary tools. API and model settings will be kept.')) return;
  const typed = prompt('Type RESET to confirm the workspace reset.');
  if (typed !== 'RESET') return;
  await runAction(async () => {
    const result = await postJson('/api/debug/clear-logs', { scope: 'all', confirmReset: true });
    state.pendingParts = [];
    state.loadingMessage = null;
    state.transcriptScope = 'main';
    state.renderSignatures.clear();
    applyBootstrapSnapshot(result.bootstrap);
  });
});
els.deleteReferenceBtn.addEventListener('click', async () => {
  const path = els.deleteReferenceBtn.dataset.path || '';
  if (!path) return;
  if (!confirm(`Delete this reference document?\n\n${path}`)) return;
  const typed = prompt('Type DELETE to confirm removal of this reference.');
  if (typed !== 'DELETE') return;
  els.deleteReferenceBtn.disabled = true;
  try {
    const result = await deleteJson<JsonMap>('/api/references', { path });
    applyBootstrapSnapshot(result.bootstrap);
    els.dialog.close();
  } catch (error) {
    showDetail('Delete failed', { message: error instanceof Error ? error.message : String(error) });
  } finally {
    els.deleteReferenceBtn.disabled = false;
  }
});

els.sendForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = els.messageInput.value.trim();
  if (!text) return;
  els.messageInput.value = '';
  autosizeComposer();
  updateSendButton();
  const pendingId = `pending-${Date.now()}`;
  state.pendingParts.push({
    id: pendingId,
    timestamp: new Date().toISOString(),
    role: 'user',
    type: 'text',
    text,
    sourceLabel: 'main',
    pending: true,
  });
  state.loadingMessage = loadingPart('Running');
  render();
  await nextPaint();
  await runStreamingAction(async () => {
    await postSend(text);
  });
});

els.uploadForm.addEventListener('submit', (event) => event.preventDefault());
els.rawZipUploadForm.addEventListener('submit', (event) => event.preventDefault());

els.uploadBtn.addEventListener('click', () => {
  if (!state.busy) els.referenceFiles.click();
});

els.rawZipUploadBtn.addEventListener('click', () => {
  if (!state.busy) els.rawZipFile.click();
});

els.referenceFiles.addEventListener('change', async () => {
  await uploadReferenceFiles();
});

els.rawZipFile.addEventListener('change', async () => {
  await uploadRawZipFile();
});

async function uploadReferenceFiles() {
  const files = [...(els.referenceFiles.files || [])];
  if (!files.length) return;
  try {
    await runAction(async () => {
      const form = new FormData();
      for (const file of files) form.append('files', file);
      await postForm('/api/references/upload', form);
    });
  } finally {
    els.referenceFiles.value = '';
  }
}

async function uploadRawZipFile() {
  const file = els.rawZipFile.files?.[0];
  if (!file) return;
  try {
    await runAction(async () => {
      const form = new FormData();
      form.append('file', file);
      const result = await postForm('/api/data/raw/upload-zip', form);
      showDetail('Raw dataset ZIP uploaded', {
        archive: result.uploaded?.archive,
        targetDir: result.uploaded?.targetDir,
        extractedCount: result.uploaded?.extracted?.length || 0,
        extracted: result.uploaded?.extracted || [],
      });
    });
  } finally {
    els.rawZipFile.value = '';
  }
}

function connectRealtimeEvents() {
  const source = new EventSource('/api/events');
  source.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data || '{}');
      applyRealtimeEvent(message.type, message.payload || {});
    } catch {
      // EventSource reconnects automatically; malformed events are ignored.
    }
  };
  window.addEventListener('beforeunload', () => source.close(), { once: true });
}

function applyRealtimeEvent(eventType: string, payload: JsonMap) {
  if (eventType === 'bootstrap_snapshot' && payload.bootstrap) {
    applyBootstrapSnapshot(payload.bootstrap as Bootstrap);
    return;
  }
  if (!state.bootstrap) return;
  if (eventType === 'main_parts') {
    state.bootstrap.mainParts = payload.mainPart
      ? appendRealtimePart(state.bootstrap.mainParts, payload.mainPart)
      : payload.mainParts || [];
    state.pendingParts = reconcilePendingParts(state.bootstrap);
    render();
    return;
  }
  if (eventType === 'knowledge_graph_parts') {
    state.bootstrap.knowledgeGraphParts = payload.knowledgeGraphPart
      ? appendRealtimePart(state.bootstrap.knowledgeGraphParts || [], payload.knowledgeGraphPart)
      : payload.knowledgeGraphParts || [];
    render();
    return;
  }
  if (eventType === 'knowledge_graph_snapshot') {
    if (payload.knowledgeGraph) state.bootstrap.knowledgeGraph = payload.knowledgeGraph;
    if (payload.knowledgeBaseSummary) state.bootstrap.knowledgeBaseSummary = payload.knowledgeBaseSummary;
    if (payload.knowledgeGraphBuild) state.bootstrap.knowledgeGraphBuild = payload.knowledgeGraphBuild;
    render();
    return;
  }
  if (eventType === 'chain_summary_parts') {
    state.bootstrap.chainSummaryParts = payload.chainSummaryPart
      ? appendRealtimePart(state.bootstrap.chainSummaryParts || [], payload.chainSummaryPart)
      : payload.chainSummaryParts || [];
    render();
    return;
  }
  if (eventType === 'reference_feature_parts') {
    state.bootstrap.referenceFeatureParts = payload.referenceFeatureParts || [];
    render();
    return;
  }
  if (eventType === 'node_parts') {
    const nodePartById = payload.nodePartById || {};
    const mergedNodeParts = { ...(state.bootstrap.nodePartsById || {}) };
    for (const [nodeId, part] of Object.entries(nodePartById)) {
      mergedNodeParts[nodeId] = appendRealtimePart(mergedNodeParts[nodeId] || [], part as JsonMap);
    }
    state.bootstrap.nodePartsById = {
      ...mergedNodeParts,
      ...(payload.nodePartsById || {}),
    };
    if (payload.nodes) state.bootstrap.nodes = payload.nodes;
    if (payload.state) state.bootstrap.state = payload.state;
    if (payload.timeline) state.bootstrap.timeline = payload.timeline;
    syncRuntimeBusy(state.bootstrap);
    state.pendingParts = reconcilePendingParts(state.bootstrap);
    render();
    resolveRealtimeWaiters(state.bootstrap);
    return;
  }
  if (eventType === 'workspace_files' && payload.fileTree) {
    state.bootstrap.fileTree = payload.fileTree;
    render();
    return;
  }
  if (eventType === 'live_snapshot' && payload.snapshot) {
    const merged = { ...state.bootstrap, ...payload.snapshot } as Bootstrap;
    applyBootstrapSnapshot(merged);
  }
}

function appendRealtimePart(parts: JsonMap[], part: JsonMap): JsonMap[] {
  if (!part || typeof part !== 'object') return parts;
  const id = String(part.id || '');
  const existingIndex = id ? parts.findIndex((item) => String(item?.id || '') === id) : -1;
  if (existingIndex < 0) return [...parts, part];
  const next = [...parts];
  next[existingIndex] = part;
  return next;
}

function applyBootstrapSnapshot(data: Bootstrap) {
  state.bootstrap = data;
  syncRuntimeBusy(data);
  state.pendingParts = reconcilePendingParts(data);
  state.loadingMessage = state.busy
    ? state.loadingMessage || loadingPart('Backend running; receiving updates')
    : null;
  render();
  resolveRealtimeWaiters(data);
}

function syncRuntimeBusy(data: Bootstrap | null) {
  if (data && isPipelineComplete(data)) {
    data.runtime = { ...(data.runtime || {}), running: false, pipelineComplete: true };
  }
  state.busy = isBackendRunning(data);
  if (!state.busy) {
    state.loadingMessage = null;
  }
}

function isBackendRunning(data: Bootstrap | null): boolean {
  if (!data) return false;
  return Boolean(data.runtime?.running) && !isPipelineComplete(data);
}

function isPipelineComplete(data: Bootstrap | null): boolean {
  const ws = data?.state || {};
  const completedNodes = Array.isArray(ws.completedNodes) ? ws.completedNodes : [];
  return Boolean(data?.runtime?.pipelineComplete)
    || (completedNodes.includes('final-summary') && !ws.activeNode && !ws.activeNodeSessionId);
}

function render() {
  const data = state.bootstrap;
  if (!data) {
    renderChat(emptyBootstrap());
    renderViewState();
    return;
  }

  const ws = data.state || {};
  const activeNode = ws.activeNode;
  const activeSession = getActiveNodeSession(data);
  const executionPhase = String(data.execution?.phase || 'ready');
  const pauseWaiting = executionPhase === 'pausing';
  const activeLabel = pauseWaiting
    ? `Pausing: ${nodeDisplayName(activeNode) || 'Main session'}`
    : activeSession?.status === 'paused'
    ? `Paused: ${nodeDisplayName(activeNode)}`
    : activeNode && !data.runtime?.running
      ? `Waiting to resume: ${nodeDisplayName(activeNode)}`
      : activeNode
        ? `Running: ${nodeDisplayName(activeNode)}`
        : 'Ready';
  const activeTone = pauseWaiting
    ? 'pending'
    : activeSession?.status === 'paused' || (activeNode && !data.runtime?.running)
    ? 'ready'
    : activeNode ? 'active' : 'ready';
  setHtmlIfChanged(els.statusText, statusPill(activeLabel, activeTone));
  els.pauseWaitHint.hidden = !pauseWaiting;
  els.pauseWaitHint.textContent = pauseWaiting
    ? 'Waiting for the current turn and subagents to stop and the checkpoint to be saved.'
    : '';
  els.modeText.textContent = data.dryRun ? `${modeLabel(ws.controlMode || ws.mode)} / Dry run` : modeLabel(ws.controlMode || ws.mode || '-');
  setHtmlIfChanged(els.variantText, variantPill(data.variant));
  els.modelText.textContent = data.llmConfig?.config?.model || 'sdk-default';
  setHtmlIfChanged(els.runtimeUvText, runtimePill(data.runtime?.workspaceUv));

  if (!state.selectedNodeType && data.nodeSpecs.length) {
    state.selectedNodeType = activeNode || data.nodeSpecs[0].type;
  }
  renderStable('nodes', [data.nodeSpecs, ws, data.nodes, state.selectedNodeType], () => renderNodes(data.nodeSpecs, ws, data.nodes));
  renderStable('node-detail', [data.nodeSpecs, data.nodes, state.selectedNodeType], () => renderNodeDetail(data.nodeSpecs, data.nodes));
  renderStable('pending-control', ws.pendingControl, () => renderPendingControl(ws.pendingControl));
  renderStable('transcript-scope', [data.nodes, state.transcriptScope], () => renderTranscriptScope(data.nodes));
  renderChat(data);
  renderStable('knowledge-graph', [data.knowledgeGraph, state.selectedGraphNodeId], () => renderKnowledgeGraph(data.knowledgeGraph));
  renderStable('knowledge-builder', [data.knowledgeGraphBuild, data.runtime, data.knowledgeGraphLlmConfig], () => renderKnowledgeGraphBuilder(data));
  renderStable('knowledge-workbench', [data.knowledgeBaseSummary, state.selectedKnowledgeBaseKind, state.knowledgeBaseCards, state.knowledgeBaseCardsBusy, state.knowledgeQuestion, state.knowledgeAnswer, state.knowledgeQueryBusy], () => renderKnowledgeWorkbench(data));
  renderStable('builder-trace', data.knowledgeGraphParts || [], () => renderBuilderTrace(data.knowledgeGraphParts || []));
  renderKnowledgeGraphTabState();
  renderChainSummary(data);
  renderEcgSamples();
  renderPatientDemo();
  renderImageViewer();
  renderStable('settings', [state.view, data.llmConfig, data.knowledgeGraphLlmConfig, data.runtimeSettings], () => renderSettings(data));
  renderViewState();
  renderStable('timeline', data.timeline, () => renderTimeline(data.timeline));
  renderStable('file-tree', data.fileTree, () => renderFileTree(data.fileTree));
  renderWorkspaceDatasetControl();
  renderStable('runtime-settings', data.runtimeSettings || ws.runtimeSettings, () => renderRuntimeSettings(data.runtimeSettings || ws.runtimeSettings));
  renderKgCta(data);
  renderChainCta(data);
  renderDebugActions(Boolean(data.debugEnabled));
  updateControls(data);
  renderShellState();
  hydrateIcons();
}

function renderStable(key: string, value: any, renderFn: () => void) {
  const signature = stableSignature(value);
  if (state.renderSignatures.get(key) === signature) return;
  state.renderSignatures.set(key, signature);
  renderFn();
}

function stableSignature(value: any) {
  const json = JSON.stringify(value ?? null);
  let hash = 2166136261;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${json.length}:${hash >>> 0}`;
}

function setHtmlIfChanged(element: HTMLElement, html: string) {
  if (element.innerHTML !== html) element.innerHTML = html;
}

function renderPendingControl(pending: JsonMap | null | undefined) {
  if (!pending) {
    els.pendingControlPanel.hidden = true;
    els.pendingControlBody.innerHTML = '';
    return;
  }
  els.pendingControlPanel.hidden = false;
  const args = pending.args || {};
  els.pendingControlBody.innerHTML = `
    <div class="control-kind">${escapeHtml(pending.kind || 'control')}</div>
    <div class="meta">${escapeHtml(pending.nodeType || '')} · ${formatTime(pending.createdAt)}</div>
    <div class="control-message">${escapeHtml(pending.message || '')}</div>
    <details>
      <summary>Arguments</summary>
      <pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre>
    </details>
  `;
}

function renderTranscriptScope(nodes: JsonMap[]) {
  const options = [
    { value: 'all', label: 'All activity' },
    { value: 'main', label: 'Main session only' },
    ...(nodes || []).slice().reverse().map((node) => ({
      value: `node:${node.id}`,
      label: `${nodeDisplayName(node.nodeType)} · ${statusLabel(node.status)} · ${formatTime(node.startedAt)}`,
    })),
  ];
  if (!options.some((option) => option.value === state.transcriptScope)) {
    state.transcriptScope = 'all';
  }
  const current = els.transcriptScope.value;
  const nextHtml = options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
  if (els.transcriptScope.innerHTML !== nextHtml) els.transcriptScope.innerHTML = nextHtml;
  els.transcriptScope.value = state.transcriptScope || current || 'all';
}

function renderDebugActions(enabled: boolean) {
  for (const element of document.querySelectorAll<HTMLElement>('.debug-only')) {
    element.hidden = !enabled;
  }
  document.querySelector<HTMLElement>('.toolbar')?.classList.toggle('compact', !enabled);
}

function renderNodes(specs: JsonMap[], ws: JsonMap, sessions: JsonMap[]) {
  const latestByType = new Map<string, JsonMap>();
  for (const session of sessions) latestByType.set(session.nodeType, session);
  const completedNodes = ws.completedNodes || [];

  els.nodeList.innerHTML = specs.map((spec, index) => {
    const session = latestByType.get(spec.type);
    const active = ws.activeNode === spec.type;
    const done = completedNodes.includes(spec.type);
    const failed = session?.status === 'failed';
    const status = active ? 'active' : failed ? 'failed' : done ? 'done' : 'pending';
    const isOpen = state.selectedNodeType === spec.type;
    return `
      <details class="node-item" data-node="${escapeHtml(spec.type)}" ${isOpen ? 'open' : ''}>
        <summary class="node-header">
          <span class="node-index">${index + 1}</span>
          <span class="node-name">${escapeHtml(nodeDisplayName(spec.type))}</span>
          <span class="badge ${status}">${statusIcon(status)}${statusLabel(status)}</span>
          <span class="node-chevron" data-icon="ChevronRight"></span>
        </summary>
        <div class="node-body">
          <div class="node-purpose">${escapeHtml(nodePhaseLabel(spec.phase))} · ${escapeHtml(nodePurposeText(spec))}</div>
        </div>
      </details>
    `;
  }).join('');

  for (const details of els.nodeList.querySelectorAll<HTMLDetailsElement>('details.node-item')) {
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      // Close any other open details (exclusive accordion)
      for (const other of els.nodeList.querySelectorAll<HTMLDetailsElement>('details.node-item')) {
        if (other !== details && other.open) other.open = false;
      }
      state.selectedNodeType = details.dataset.node || null;
      renderNodeDetail(specs, sessions);
    });
  }
}

function renderNodeDetail(specs: JsonMap[], nodes: JsonMap[]) {
  const type = state.selectedNodeType;
  const spec = specs.find((candidate) => candidate.type === type);
  if (!spec) {
    els.nodeDetail.innerHTML = emptyState('Select a stage.', 'Info');
    return;
  }
  const sessions = nodes.filter((node) => node.nodeType === type).slice().reverse();
  const produced = unique([
    ...(spec.produces || []),
    ...sessions.flatMap((node) => node.outputPaths || []),
  ]);
  els.nodeDetail.innerHTML = `
    <div class="node-detail-title">${escapeHtml(nodeDisplayName(spec.type))}</div>
    <div class="meta">${escapeHtml(nodePurposeText(spec))}</div>
    <div class="detail-section-title">Artifacts</div>
    ${produced.length ? `<div class="artifact-list">${produced.map((path) => `
      <button class="artifact-item" data-path="${escapeHtml(path)}"><span data-icon="File"></span><span>${escapeHtml(path)}</span></button>
    `).join('')}</div>` : emptyState('No stage artifacts.', 'File')}
    <div class="detail-section-title">Execution history</div>
    ${sessions.length ? `<div class="session-list">${sessions.map((node) => `
      <button class="session-item" data-session="${escapeHtml(node.id)}">
        <span class="session-title">${escapeHtml(statusLabel(node.status))} · ${formatTime(node.startedAt)}</span>
        <span class="meta">${escapeHtml(node.summary || node.rationale || '')}</span>
      </button>
    `).join('')}</div>` : emptyState('No stage sessions.', 'Activity')}
  `;

  for (const item of els.nodeDetail.querySelectorAll<HTMLElement>('.session-item')) {
    item.addEventListener('click', async () => {
      const log = await fetchJson(`/api/nodes/${item.dataset.session}/log`);
      showDetail(`Stage log ${item.dataset.session}`, displaySafeSessionParts(log));
    });
  }
  for (const item of els.nodeDetail.querySelectorAll<HTMLElement>('.artifact-item')) {
    item.addEventListener('click', async () => showWorkspaceFile(item.dataset.path || ''));
  }
}

function renderChat(data: Bootstrap) {
  const wasNearBottom = els.chatStream.scrollHeight - els.chatStream.scrollTop - els.chatStream.clientHeight < 160;
  const savedScroll = els.chatStream.scrollTop;
  const parts = collectTranscriptParts(data);
  const visibleParts = normalizeChatParts(parts);
  const loadingParts = collectLoadingParts();
  const renderedParts = [...visibleParts, ...loadingParts];
  if (!renderedParts.length) {
    if (!els.chatStream.querySelector('.welcome-state') || els.chatStream.childElementCount !== 1) {
      els.chatStream.innerHTML = `
        <div class="welcome-state">
          <div class="welcome-orbit"><span data-icon="Sparkles"></span></div>
          <h3>Start a time-series task</h3>
          <p>Send a task to start the workflow. Execution activity will appear here.</p>
        </div>
      `;
      hydrateIcons(els.chatStream);
    }
    updateChatTopButton();
    return;
  }

  els.chatStream.querySelector('.welcome-state')?.remove();
  const existing = new Map<string, HTMLElement>();
  for (const element of els.chatStream.querySelectorAll<HTMLElement>('[data-message-key]')) {
    const key = element.dataset.messageKey;
    if (key) existing.set(key, element);
  }

  const desired: HTMLElement[] = [];
  const desiredKeys = new Set<string>();
  let changed = false;
  renderedParts.forEach((part, index) => {
    const key = messageKey(part, index);
    const fingerprint = stableSignature(part);
    desiredKeys.add(key);
    let element = existing.get(key);
    if (!element || element.dataset.messageFingerprint !== fingerprint) {
      const replacement = createMessageElement(part, key, fingerprint);
      if (element) element.remove();
      element = replacement;
      changed = true;
    }
    desired.push(element);
  });

  for (const [key, element] of existing) {
    if (!desiredKeys.has(key)) {
      element.remove();
      changed = true;
    }
  }

  let cursor = els.chatStream.firstElementChild;
  for (const element of desired) {
    if (element !== cursor) {
      els.chatStream.insertBefore(element, cursor);
      changed = true;
    }
    cursor = element.nextElementSibling;
  }

  if (changed && wasNearBottom) {
    els.chatStream.scrollTop = els.chatStream.scrollHeight;
  } else if (changed && savedScroll < els.chatStream.scrollHeight) {
    els.chatStream.scrollTop = Math.min(savedScroll, els.chatStream.scrollHeight - els.chatStream.clientHeight);
  }
  updateChatTopButton();
}

function messageKey(part: JsonMap, index: number) {
  return String(part.id || part.sortKey || `${part.role || 'system'}:${part.type || 'text'}:${part.timestamp || index}`);
}

function createMessageElement(part: JsonMap, key: string, fingerprint: string) {
  const template = document.createElement('template');
  template.innerHTML = messageHtml(part).trim();
  const element = template.content.firstElementChild as HTMLElement | null;
  if (!element) throw new Error(`Unable to render message ${key}`);
  element.dataset.messageKey = key;
  element.dataset.messageFingerprint = fingerprint;
  bindToolCards(element);
  hydrateIcons(element);
  return element;
}

function renderRuntimeSettings(settings: JsonMap | null | undefined) {
  const graphDepth = settings?.knowledgeGraphExtractionDepth ?? 2;
  if (els.graphExtractionDepthInput.value !== String(graphDepth)) els.graphExtractionDepthInput.value = String(graphDepth);
}

function renderKgCta(data: Bootstrap) {
  if (!data) return;
  const build = data.knowledgeGraphBuild || {};
  const graph = data.knowledgeGraph || {};
  const running = Boolean(data.runtime?.knowledgeGraphRunning || build.running);
  const classes = (graph.nodes || []).length;
  const relations = (graph.edges || []).length;
  let state: 'idle' | 'building' | 'built' | 'failed' = 'idle';
  let label = 'Idle';
  if (build.status === 'failed') {
    state = 'failed';
    label = 'Failed';
  } else if (running) {
    state = 'building';
    label = 'Building';
  } else if (build.status === 'completed' && classes > 0) {
    state = 'built';
    label = 'Built';
  }
  els.kgCta.dataset.state = state;
  els.kgCtaPill.textContent = label;
  els.kgCtaPill.className = `kg-cta-pill ${state}`;
  els.kgCtaStats.textContent = classes > 0 || relations > 0
    ? `${classes} concepts · ${relations} relations`
    : 'Not built';
}

function renderChainCta(data: Bootstrap) {
  if (!data) return;
  const build = data.chainSummaryBuild || {};
  const summary = data.chainSummary || {};
  const running = Boolean(data.runtime?.chainSummaryRunning || build.running);
  const iterations = Array.isArray(summary.iterations) ? summary.iterations.length : 0;
  const metrics = Array.isArray(summary.metricSeries) ? summary.metricSeries.length : 0;
  let ctaState: 'idle' | 'building' | 'built' | 'failed' = 'idle';
  let label = 'Idle';
  if (build.status === 'failed') {
    ctaState = 'failed';
    label = 'Failed';
  } else if (running) {
    ctaState = 'building';
    label = 'Generating';
  } else if (build.status === 'completed' || iterations > 0 || metrics > 0) {
    ctaState = 'built';
    label = 'View';
  }
  els.chainCta.dataset.state = ctaState;
  els.chainCtaPill.textContent = label;
  els.chainCtaPill.className = `kg-cta-pill ${ctaState}`;
  const featureBuild = data.referenceFeatureBuild || {};
  const featureCount = Number(featureBuild.featureCount || data.referenceFeatureTool?.featureCount || 0);
  let featureLabel: string | null = null;
  if (featureBuild.status === 'completed' && featureBuild.ready !== false) {
    featureLabel = `Features: ${featureCount}`;
  } else if (featureBuild.status === 'failed') {
    featureLabel = 'Features: failed';
  } else if (data.variant?.capabilities?.referenceFeatureExtractor === false) {
    featureLabel = `Features: disabled · ${data.variant?.id || 'variant'}`;
  }
  const base = iterations || metrics ? `${iterations} iterations · ${metrics} metrics` : 'Not generated';
  els.chainCtaStats.textContent = featureLabel ? `${base} · ${featureLabel}` : base;
}

function syncSettingsFromBootstrap(data: Bootstrap) {
  const settings = data.runtimeSettings || data.state?.runtimeSettings || {};
  state.settings.iterativeK = settings.iterativeCandidateCount ?? 3;
  state.settings.graphDepth = settings.knowledgeGraphExtractionDepth ?? 2;

  const main = data.llmConfig?.config || {};
  state.settings.mainAuthMode = main.authMode || 'manual';
  state.settings.mainProtocol = main.protocol || '';
  state.settings.mainModel = main.model || '';
  state.settings.mainBaseUrl = main.baseUrl || '';
  // apiKey is masked (e.g. "****1234"); never seed the editor with a real value

  const graph = data.knowledgeGraphLlmConfig?.config || {};
  state.settings.graphAuthMode = graph.authMode || 'manual';
  state.settings.graphProtocol = graph.protocol || '';
  state.settings.graphModel = graph.model || '';
  state.settings.graphBaseUrl = graph.baseUrl || '';

  // The reference feature extractor is built by the main session; no
  // independent LLM config is needed. The validated tool status is
  // surfaced through the node detail panel and the chain CTA.
}

function renderSettings(data: Bootstrap) {
  if (state.view !== 'settings') return;
  if (!data) return;
  syncSettingsFromBootstrap(data);
  const ws = data.state || {};

  const workspaceRows = [
    { label: 'Workflow variant', value: variantPill(data.variant) },
    { label: 'Current stage', value: ws.activeNode
      ? `<span class="settings-readout-pill active">${escapeHtml(nodeDisplayName(ws.activeNode))}</span>`
      : `<span class="settings-readout-pill">—</span>` },
    { label: 'Control mode', value: `<span class="settings-readout-pill ${ws.controlMode === 'auto' ? 'active' : ''}">${escapeHtml(modeLabel(ws.controlMode || ws.mode || 'manual'))}</span>` },
    { label: 'Dry run', value: data.dryRun
      ? `<span class="settings-readout-pill active">On</span>`
      : `<span class="settings-readout-pill">Off</span>` },
    { label: 'Debug controls', value: data.debugEnabled
      ? `<span class="settings-readout-pill active">Enabled</span>`
      : `<span class="settings-readout-pill">Disabled</span>` },
    { label: 'Runtime', value: runtimePill(data.runtime?.workspaceUv) },
    { label: 'Workspace path', value: `<span class="settings-readout-mono">${escapeHtml(data.runtime?.workspaceUv?.workspace || '')}</span>`, copyable: data.runtime?.workspaceUv?.workspace || '' },
  ];

  const kOptions = [1, 2, 3, 4, 5, 6, 7, 8];
  const depthOptions = [1, 2, 3, 4];

  els.settingsContent.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-header">Workspace</div>
      <div class="settings-card">
        ${workspaceRows.map((row) => `
          <div class="settings-row">
            <div class="settings-row-label">${escapeHtml(row.label)}</div>
            <div class="settings-row-control">${row.value}${row.copyable ? `<button class="settings-icon-btn" type="button" data-copy="${escapeHtml(row.copyable)}" title="Copy"><span data-icon="Archive"></span></button>` : ''}</div>
          </div>
        `).join('')}
        <div class="settings-row">
          <div class="settings-row-label">Details</div>
          <div class="settings-row-control settings-inline-actions">
            <button class="settings-secondary-btn" type="button" data-settings-detail="state"><span data-icon="Archive"></span><span>View state file</span></button>
            <button class="settings-secondary-btn" type="button" data-settings-detail="llm"><span data-icon="Settings2"></span><span>View model configuration</span></button>
          </div>
        </div>
      </div>
      <p class="settings-section-foot">These values come from server startup settings such as <code>TS_HARNESS_VARIANT</code>, <code>TS_HARNESS_CONTROL_MODE</code>, <code>TS_HARNESS_DRY_RUN</code>, and <code>TS_HARNESS_DEBUG</code>. Restart the service to change them.</p>
    </div>

    <div class="settings-section">
      <div class="settings-section-header">Runtime parameters</div>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-label">
            <div>Candidates per iteration (k)</div>
            <div class="settings-row-help">Number of method candidates proposed in each iteration.</div>
          </div>
          <div class="settings-row-control">
            ${segmentedHtml('iterativeK', kOptions.map(String), String(state.settings.iterativeK), (v) => v)}
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">
            <div>Knowledge graph depth</div>
            <div class="settings-row-help">Number of relationship hops extracted from each reference source.</div>
          </div>
          <div class="settings-row-control">
            ${segmentedHtml('graphDepth', depthOptions.map(String), String(state.settings.graphDepth), (v) => v)}
          </div>
        </div>
      </div>
    </div>

    ${renderLlmSection('graph', 'Knowledge graph model', 'Used by the reference knowledge builder. Leave blank to inherit the primary model.')}
    ${renderLlmSection('main', 'Primary model', 'Used by the orchestrator and stage agents. Saved to <code>&lt;workspace&gt;/config.llm.json</code>; usually applies to the next message.', true)}
  `;

  bindSettingsHandlers();
  hydrateIcons(els.settingsContent);
}

function renderLlmSection(prefix: 'graph' | 'main', title: string, description: string, isMain = false): string {
  const s = state.settings;
  const authValue = (isMain ? s.mainAuthMode : s.graphAuthMode) || 'manual';
  const protocolValue = isMain ? s.mainProtocol : s.graphProtocol;
  const modelValue = isMain ? s.mainModel : s.graphModel;
  const baseUrlValue = isMain ? s.mainBaseUrl : s.graphBaseUrl;
  const authOptions = [
    { value: 'manual', label: 'Manual configuration' },
    { value: 'sdk-default', label: 'SDK default' },
  ];
  const protocolOptions = [
    { value: '', label: 'Auto' },
    { value: 'deepseek', label: 'deepseek' },
    { value: 'openai-compat', label: 'openai-compat' },
  ];
  const modelPlaceholder = isMain ? 'e.g. deepseek-v4-pro' : 'Inherit primary model';
  const baseUrlPlaceholder = isMain ? 'https://api.deepseek.com' : 'Inherit primary API URL';
  const apiKeyPlaceholder = 'Leave blank to keep the current key';
  const saveBtnId = isMain ? 'saveMainLlmBtn' : 'saveGraphLlmBtn2';
  const resetBtnId = isMain ? 'resetMainLlmBtn' : '';
  const modelId = `${prefix}Model`;
  const baseUrlId = `${prefix}BaseUrl`;
  const apiKeyId = `${prefix}ApiKey`;
  return `
    <div class="settings-section">
      <div class="settings-section-header">${escapeHtml(title)}</div>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-label">Authentication</div>
          <div class="settings-row-control">${segmentedHtml(`${prefix}AuthMode`, authOptions.map((o) => o.value), authValue, (v) => v, authOptions.map((o) => o.label))}</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">API protocol</div>
          <div class="settings-row-control">${segmentedHtml(`${prefix}Protocol`, protocolOptions.map((o) => o.value), protocolValue, (v) => v, protocolOptions.map((o) => o.label))}</div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">Model</div>
          <div class="settings-row-control"><input class="settings-input" type="text" id="${modelId}" value="${escapeHtml(modelValue)}" placeholder="${escapeHtml(modelPlaceholder)}" /></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">API base URL</div>
          <div class="settings-row-control"><input class="settings-input" type="text" id="${baseUrlId}" value="${escapeHtml(baseUrlValue)}" placeholder="${escapeHtml(baseUrlPlaceholder)}" /></div>
        </div>
        <div class="settings-row">
          <div class="settings-row-label">API key</div>
          <div class="settings-row-control"><input class="settings-input" type="password" id="${apiKeyId}" value="" placeholder="${escapeHtml(apiKeyPlaceholder)}" autocomplete="off" /></div>
        </div>
        <div class="settings-card-footer">
          <button id="${saveBtnId}" type="button" class="settings-primary-btn"><span data-icon="Check"></span><span>${escapeHtml(isMain ? 'Save primary model' : 'Save graph model')}</span></button>
          ${isMain ? `<button id="${resetBtnId}" type="button" class="settings-secondary-btn"><span data-icon="RefreshCw"></span><span>Restore file defaults</span></button>` : ''}
          <span class="settings-save-status" id="${prefix}SaveStatus"></span>
        </div>
      </div>
      <p class="settings-section-foot">${description}</p>
    </div>
  `;
}

function segmentedHtml(group: string, values: string[], current: string, format: (v: string) => string = (v) => v, labels: string[] | null = null): string {
  return `
    <div class="settings-segmented" data-segmented-group="${escapeHtml(group)}" role="group">
      ${values.map((v, i) => {
        const label = labels ? labels[i] : format(v);
        const selected = (current || '') === v ? 'selected' : '';
        return `<button type="button" class="settings-segmented-item ${selected}" data-value="${escapeHtml(v)}">${escapeHtml(label)}</button>`;
      }).join('')}
    </div>
  `;
}

function bindSettingsHandlers() {
  for (const group of els.settingsContent.querySelectorAll<HTMLElement>('[data-segmented-group]')) {
    const name = group.dataset.segmentedGroup || '';
    for (const item of group.querySelectorAll<HTMLButtonElement>('.settings-segmented-item')) {
      item.addEventListener('click', () => {
        const value = item.dataset.value || '';
        for (const sibling of group.querySelectorAll<HTMLButtonElement>('.settings-segmented-item')) {
          sibling.classList.toggle('selected', sibling === item);
        }
        if (name === 'iterativeK') {
          state.settings.iterativeK = Number(value) || 3;
          saveRuntimeSettings();
        } else if (name === 'graphDepth') {
          state.settings.graphDepth = Number(value) || 2;
          saveRuntimeSettings();
        } else if (name === 'graphAuthMode') state.settings.graphAuthMode = value;
        else if (name === 'graphProtocol') state.settings.graphProtocol = value;
        else if (name === 'mainAuthMode') state.settings.mainAuthMode = value;
        else if (name === 'mainProtocol') state.settings.mainProtocol = value;
      });
    }
  }
  for (const input of els.settingsContent.querySelectorAll<HTMLInputElement>('.settings-input')) {
    input.addEventListener('input', () => {
      const id = input.id;
      if (id === 'graphModel') state.settings.graphModel = input.value;
      else if (id === 'graphBaseUrl') state.settings.graphBaseUrl = input.value;
      else if (id === 'graphApiKey') state.settings.graphApiKey = input.value;
      else if (id === 'mainModel') state.settings.mainModel = input.value;
      else if (id === 'mainBaseUrl') state.settings.mainBaseUrl = input.value;
      else if (id === 'mainApiKey') state.settings.mainApiKey = input.value;
    });
  }
  const graphSave = els.settingsContent.querySelector<HTMLButtonElement>('#saveGraphLlmBtn2');
  graphSave?.addEventListener('click', () => saveLlmConfig(false));
  const mainSave = els.settingsContent.querySelector<HTMLButtonElement>('#saveMainLlmBtn');
  mainSave?.addEventListener('click', () => saveLlmConfig(true));
  const mainReset = els.settingsContent.querySelector<HTMLButtonElement>('#resetMainLlmBtn');
  mainReset?.addEventListener('click', () => resetMainLlmConfig());
  for (const detailBtn of els.settingsContent.querySelectorAll<HTMLButtonElement>('[data-settings-detail]')) {
    detailBtn.addEventListener('click', () => {
      if (detailBtn.dataset.settingsDetail === 'state') {
        showDetail('Workspace state file', state.bootstrap?.state);
      } else {
        showDetail('Model configuration', state.bootstrap?.llmConfig);
      }
    });
  }
  for (const copyBtn of els.settingsContent.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    copyBtn.addEventListener('click', async () => {
      const text = copyBtn.dataset.copy || '';
      try {
        await navigator.clipboard.writeText(text);
        const original = copyBtn.innerHTML;
        copyBtn.innerHTML = '<span data-icon="Check"></span>';
        copyBtn.classList.add('copied');
        hydrateIcons(copyBtn);
        window.setTimeout(() => {
          copyBtn.innerHTML = original;
          copyBtn.classList.remove('copied');
          hydrateIcons(copyBtn);
        }, 1100);
      } catch (error) {
        showDetail('Copy failed', { message: error instanceof Error ? error.message : String(error) });
      }
    });
  }
}

async function saveRuntimeSettings() {
  const result = await postJson('/api/runtime-settings', {
    iterativeCandidateCount: state.settings.iterativeK,
    knowledgeGraphExtractionDepth: state.settings.graphDepth,
  });
  applyBootstrapSnapshot(result.bootstrap);
}

async function saveLlmConfig(isMain: boolean) {
  const s = state.settings;
  const statusSelector = isMain ? '#mainSaveStatus' : '#graphSaveStatus';
  const body: JsonMap = isMain
    ? {
        authMode: s.mainAuthMode,
        protocol: s.mainProtocol,
        model: s.mainModel,
        apiKey: s.mainApiKey || undefined,
        baseUrl: s.mainBaseUrl,
      }
    : {
        authMode: s.graphAuthMode,
        protocol: s.graphProtocol,
        model: s.graphModel,
        apiKey: s.graphApiKey || undefined,
        baseUrl: s.graphBaseUrl,
      };
  try {
    const url = isMain ? '/api/llm-config' : '/api/knowledge-graph/llm-config';
    const result = await postJson(url, body);
    applyBootstrapSnapshot(result.bootstrap);
    // Clear the password field after a successful save.
    if (isMain) {
      state.settings.mainApiKey = '';
      const input = document.getElementById('mainApiKey') as HTMLInputElement | null;
      if (input) input.value = '';
    } else {
      state.settings.graphApiKey = '';
      const input = document.getElementById('graphApiKey') as HTMLInputElement | null;
      if (input) input.value = '';
    }
    const status = els.settingsContent.querySelector<HTMLElement>(statusSelector);
    if (status) {
      status.textContent = 'Saved';
      status.classList.add('saved');
      window.setTimeout(() => {
        status.textContent = '';
        status.classList.remove('saved');
      }, 1800);
    }
  } catch (error) {
    showDetail(isMain ? 'Failed to save primary model' : 'Failed to save graph model', { message: error instanceof Error ? error.message : String(error) });
  }
}

async function resetMainLlmConfig() {
  if (!confirm('Restore the primary model from file defaults? This clears the saved model, API URL, and protocol in <workspace>/config.llm.json. The API key will be kept.')) return;
  try {
    const result = await postJson('/api/llm-config', {
      authMode: 'sdk-default',
      protocol: '',
      model: '',
      baseUrl: '',
    });
    syncSettingsFromBootstrap(result.bootstrap);
    applyBootstrapSnapshot(result.bootstrap);
  } catch (error) {
    showDetail('Failed to restore primary model', { message: error instanceof Error ? error.message : String(error) });
  }
}

async function loadEcgDatasets(force = false) {
  if (state.ecgDatasets.length && !force) {
    renderWorkspaceDatasetControl();
    return;
  }
  try {
    const registry = await fetchJson<JsonMap>('/api/ecg/datasets');
    state.ecgDatasets = Array.isArray(registry.datasets) ? registry.datasets : [];
    const available = state.ecgDatasets.some((dataset) => dataset.key === state.ecgDatasetKey);
    if (!state.ecgDatasetKey || !available) state.ecgDatasetKey = String(registry.selected || state.ecgDatasets[0]?.key || '');
  } catch (error) {
    state.ecgError = error instanceof Error ? error.message : String(error);
  }
  renderWorkspaceDatasetControl();
}

async function loadEcgOverview(force = false) {
  if (state.ecgBusy || (state.ecgOverview && !force)) return;
  state.ecgBusy = true;
  state.ecgError = '';
  renderEcgSamples();
  const params = new URLSearchParams({ status: state.ecgStatus, limit: '120' });
  if (state.ecgLabel) params.set('label', state.ecgLabel);
  try {
    await loadEcgDatasets(force);
    if (state.ecgDatasetKey) params.set('dataset', state.ecgDatasetKey);
    state.ecgOverview = await fetchJson<JsonMap>(`/api/ecg/overview?${params}`);
    if (!state.ecgDatasetKey && state.ecgOverview.datasetKey) state.ecgDatasetKey = String(state.ecgOverview.datasetKey);
    const samples = Array.isArray(state.ecgOverview.samples) ? state.ecgOverview.samples : [];
    const stillAvailable = samples.some((sample: JsonMap) => Number(sample.ecgId) === state.selectedEcgId);
    state.selectedEcgId = stillAvailable ? state.selectedEcgId : samples[0]?.ecgId ?? null;
    state.ecgWaveform = null;
    renderEcgSamples();
    if (state.selectedEcgId !== null) await selectEcgSample(state.selectedEcgId);
  } catch (error) {
    state.ecgOverview = null;
    state.ecgWaveform = null;
    state.ecgError = error instanceof Error ? error.message : String(error);
  } finally {
    state.ecgBusy = false;
    renderEcgSamples();
  }
}

async function loadPatientOverview(force = false) {
  if (state.patientBusy || (state.patientOverview && !force)) return;
  state.patientBusy = true;
  state.patientError = '';
  renderPatientDemo();
  try {
    await loadEcgDatasets();
    const params = new URLSearchParams({ status: 'all', limit: '120' });
    if (state.ecgDatasetKey) params.set('dataset', state.ecgDatasetKey);
    state.patientOverview = await fetchJson<JsonMap>(`/api/ecg/overview?${params}`);
    const samples = Array.isArray(state.patientOverview.samples) ? state.patientOverview.samples : [];
    const pinned = (state.ecgOverview?.samples || []).find((item: JsonMap) => Number(item.ecgId) === state.patientSampleId);
    if (pinned && !samples.some((item: JsonMap) => Number(item.ecgId) === state.patientSampleId)) samples.unshift(pinned);
    if (!samples.some((item: JsonMap) => Number(item.ecgId) === state.patientSampleId)) state.patientSampleId = samples[0]?.ecgId ?? null;
  } catch (error) {
    state.patientOverview = null;
    state.patientError = error instanceof Error ? error.message : String(error);
  } finally {
    state.patientBusy = false;
    renderPatientDemo();
  }
}

function renderPatientMessages() {
  els.patientQaMessages.innerHTML = state.patientMessages.length
    ? state.patientMessages.map((message) => `<div class="patient-message ${message.role}"><span>${message.role === 'user' ? 'Question' : message.source === 'safety' ? 'Safety notice' : message.source === 'error' ? 'Service notice' : 'AI response'}</span><p>${escapeHtml(message.text)}</p></div>`).join('')
    : '<p class="patient-qa-welcome">Ask about report terms, certainty, or general next steps.</p>';
  if (state.patientQaBusy) els.patientQaMessages.insertAdjacentHTML('beforeend', '<div class="patient-message assistant" role="status"><span>AI response</span><p>Thinking...</p></div>');
  els.patientQuestion.disabled = state.patientQaBusy;
  const submit = els.patientQaForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submit) submit.disabled = state.patientQaBusy;
  els.patientQaMessages.scrollTop = els.patientQaMessages.scrollHeight;
}

function renderPatientDemo() {
  if (state.view !== 'patient') return;
  const overview = state.patientOverview;
  const samples = Array.isArray(overview?.samples) ? overview.samples : [];
  const sample = samples.find((item: JsonMap) => Number(item.ecgId) === state.patientSampleId) || null;
  els.patientDatasetName.textContent = overview?.datasetName || '';
  els.patientSampleSelect.innerHTML = samples.map((item: JsonMap) => `<option value="${Number(item.ecgId)}">Demo case ${Number(item.ecgId)}</option>`).join('');
  if (sample) els.patientSampleSelect.value = String(sample.ecgId);
  els.patientSampleSelect.disabled = !samples.length;
  els.patientEmptyState.hidden = Boolean(sample);
  els.patientContent.hidden = !sample;
  if (!sample) {
    els.patientEmptyState.textContent = state.patientBusy ? 'Loading demo cases…' : state.patientError || 'No cases are available.';
    return;
  }
  els.patientReportBody.innerHTML = renderPatientReport(sample, state.ecgDatasetKey);
  renderPatientMessages();
}

async function selectEcgSample(ecgId: number) {
  state.selectedEcgId = ecgId;
  state.ecgWaveform = null;
  state.ecgError = '';
  renderEcgSamples();
  try {
    const params = new URLSearchParams();
    if (state.ecgDatasetKey) params.set('dataset', state.ecgDatasetKey);
    state.ecgWaveform = await fetchJson<JsonMap>(`/api/ecg/samples/${ecgId}/waveform?${params}`);
  } catch (error) {
    state.ecgError = error instanceof Error ? error.message : String(error);
  }
  renderEcgSamples();
}

function renderEcgSamples() {
  if (state.view !== 'ecgSamples') return;
  els.ecgStatusFilter.value = state.ecgStatus;
  els.ecgLabelFilter.value = state.ecgLabel;
  els.refreshEcgBtn.disabled = state.ecgBusy;
  els.ecgDatasetSelect.innerHTML = state.ecgDatasets.map((dataset: JsonMap) => {
    const detail = dataset.iteration ? ` · iteration ${escapeHtml(dataset.iteration)}` : '';
    return `<option value="${escapeHtml(dataset.key)}">${escapeHtml(dataset.name || dataset.key)}${detail}</option>`;
  }).join('');
  if (state.ecgDatasetKey) els.ecgDatasetSelect.value = state.ecgDatasetKey;
  els.ecgDatasetSelect.disabled = state.ecgBusy || state.ecgDatasets.length <= 1;
  const overview = state.ecgOverview;
  if (!overview) {
    els.ecgWorkbench.hidden = true;
    els.ecgMetricStrip.innerHTML = '';
    els.ecgMatchCount.textContent = '';
    els.ecgEmptyState.hidden = false;
    els.ecgEmptyState.innerHTML = state.ecgBusy
      ? '<span data-icon="Loader2" class="spinning"></span><strong>Loading the latest complete run</strong>'
      : `<span data-icon="AlertTriangle"></span><div><strong>ECG cases are unavailable</strong><p>${escapeHtml(state.ecgError || 'This workspace has no complete metrics and prediction artifacts.')}</p></div>`;
    hydrateIcons(els.ecgEmptyState);
    return;
  }

  els.ecgWorkspaceMeta.textContent = `${overview.datasetName || 'Current dataset'} · iteration ${overview.iteration} · ${overview.split} · ${overview.sampleCount} records`;
  els.ecgMetricStrip.innerHTML = (overview.classes || []).map((metric: JsonMap) => `
    <article class="ecg-class-metric">
      <div class="ecg-class-name">${escapeHtml(metric.class)}</div>
      <strong>${formatPercent(metric.f1)}</strong>
      <span>F1</span>
      <dl><dt>Cases</dt><dd>${escapeHtml(metric.support_true)}</dd><dt>Missed</dt><dd>${escapeHtml(metric.FN)}</dd><dt>Recall</dt><dd>${formatPercent(metric.recall)}</dd></dl>
    </article>
  `).join('');
  const samples = Array.isArray(overview.samples) ? overview.samples : [];
  els.ecgMatchCount.textContent = `${overview.matchedCount} matching · ${samples.length} shown`;
  els.ecgEmptyState.hidden = samples.length > 0;
  els.ecgWorkbench.hidden = samples.length === 0;
  if (!samples.length) {
    els.ecgEmptyState.innerHTML = '<span data-icon="Info"></span><strong>No cases match these filters</strong>';
    hydrateIcons(els.ecgEmptyState);
    return;
  }

  els.ecgSampleList.innerHTML = samples.map((sample: JsonMap) => {
    const selected = Number(sample.ecgId) === state.selectedEcgId ? ' selected' : '';
    const truth = sample.truth?.join(' + ') || 'NONE';
    const predicted = sample.predicted?.join(' + ') || 'NONE';
    return `<button type="button" class="ecg-sample-row${selected}" data-ecg-id="${escapeHtml(sample.ecgId)}">
      <span class="ecg-sample-id">ECG ${escapeHtml(sample.ecgId)}</span>
      <span class="ecg-sample-route"><b>${escapeHtml(truth)}</b><i>→</i><b>${escapeHtml(predicted)}</b></span>
      <span class="ecg-sample-meta">Age ${escapeHtml(sample.age ?? 'unknown')} · ${escapeHtml(sample.sex === '男' ? 'Male' : sample.sex === '女' ? 'Female' : 'Unknown')} · ${escapeHtml(sample.subclasses?.join(', ') || 'No subclass')}</span>
    </button>`;
  }).join('');

  const sample = samples.find((item: JsonMap) => Number(item.ecgId) === state.selectedEcgId) || samples[0];
  renderEcgResult(sample, overview.thresholds || {});
  const reviewKey = `${state.ecgDatasetKey}:${overview.iteration}:${sample.ecgId}`;
  if (els.clinicalReviewPane.dataset.sampleKey !== reviewKey) {
    els.clinicalReviewPane.innerHTML = renderClinicalReview(sample, state.ecgDatasetKey);
    els.clinicalReviewPane.dataset.sampleKey = reviewKey;
  }
  renderEcgWaveform(sample);
}

function renderEcgResult(sample: JsonMap, thresholds: JsonMap) {
  const truth = sample.truth || [];
  const predicted = sample.predicted || [];
  const labels = ['NORM', 'MI', 'STTC', 'CD', 'HYP'];
  const outcome = sample.exact
    ? '<span class="ecg-outcome correct">Exact match</span>'
    : `<span class="ecg-outcome error">${sample.missed?.length ? `Missed ${escapeHtml(sample.missed.join(', '))}` : ''}${sample.missed?.length && sample.added?.length ? ' · ' : ''}${sample.added?.length ? `Extra ${escapeHtml(sample.added.join(', '))}` : ''}</span>`;
  els.ecgResultDetail.innerHTML = `
    <div class="ecg-result-summary">
      ${outcome}
      <div><span>Reference labels</span><strong>${escapeHtml(truth.join(' + ') || 'NONE')}</strong></div>
      <div><span>Predicted labels</span><strong>${escapeHtml(predicted.join(' + ') || 'NONE')}</strong></div>
    </div>
    <div class="ecg-probabilities">
      ${labels.map((label) => {
        const score = Number(sample.scores?.[label] || 0);
        const threshold = Number(thresholds[label] || 0.5);
        const thresholdLeft = Math.max(0, Math.min(100, threshold * 100));
        return `<div class="ecg-probability-row ${predicted.includes(label) ? 'positive' : ''}">
          <div><strong>${label}</strong><span>${score.toFixed(3)} / threshold ${threshold.toFixed(3)}</span></div>
          <div class="ecg-probability-track"><span style="width:${Math.max(0, Math.min(100, score * 100))}%"></span><i style="left:${thresholdLeft}%"></i></div>
        </div>`;
      }).join('')}
    </div>
    <div class="ecg-result-note">Scores and thresholds come from this iteration's validation results. The waveform supports case inspection, not a clinical diagnosis.</div>
  `;
}

function renderEcgWaveform(sample: JsonMap) {
  els.ecgWaveformHeading.textContent = `12-lead ECG · ECG ${sample.ecgId}`;
  if (!state.ecgWaveform || Number(state.ecgWaveform.ecgId) !== Number(sample.ecgId)) {
    els.ecgWaveformGrid.innerHTML = state.ecgError
      ? `<div class="ecg-waveform-message"><span data-icon="AlertTriangle"></span>${escapeHtml(state.ecgError)}</div>`
      : '<div class="ecg-waveform-message"><span data-icon="Loader2" class="spinning"></span>Loading recorded WFDB waveform</div>';
    hydrateIcons(els.ecgWaveformGrid);
    return;
  }
  const duration = Number(state.ecgWaveform.durationSeconds || 10);
  els.ecgWaveformGrid.innerHTML = (state.ecgWaveform.leads || []).map((lead: JsonMap) => {
    const values = Array.isArray(lead.values) ? lead.values.map(Number) : [];
    const width = 900;
    const height = 118;
    const amplitude = Math.max(1.4, ...values.map((value: number) => Math.abs(value)));
    const scale = (height * 0.42) / amplitude;
    const path = values.map((value: number, index: number) => {
      const x = values.length <= 1 ? 0 : (index / (values.length - 1)) * width;
      const y = height / 2 - value * scale;
      return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
    return `<figure class="ecg-lead">
      <figcaption>${escapeHtml(lead.name)}</figcaption>
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Lead ${escapeHtml(lead.name)}, ${duration} seconds of recorded ECG">
        <defs><pattern id="ecgSmallGrid-${escapeHtml(lead.name)}" width="18" height="18" patternUnits="userSpaceOnUse"><path d="M 18 0 L 0 0 0 18" fill="none" stroke="#f3d9dc" stroke-width="0.7"/></pattern><pattern id="ecgGrid-${escapeHtml(lead.name)}" width="90" height="90" patternUnits="userSpaceOnUse"><rect width="90" height="90" fill="url(#ecgSmallGrid-${escapeHtml(lead.name)})"/><path d="M 90 0 L 0 0 0 90" fill="none" stroke="#e9b8be" stroke-width="1"/></pattern></defs>
        <rect width="100%" height="100%" fill="url(#ecgGrid-${escapeHtml(lead.name)})"/>
        <path d="${path}" fill="none" stroke="#17252f" stroke-width="1.35" vector-effect="non-scaling-stroke"/>
      </svg>
    </figure>`;
  }).join('');
}

function formatPercent(value: any) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(1)}%` : '-';
}

function renderViewState() {
  const graphMode = state.view === 'knowledgeGraph';
  const chainMode = state.view === 'chainSummary';
  const ecgMode = state.view === 'ecgSamples';
  const patientMode = state.view === 'patient';
  const imageMode = state.view === 'imageViewer';
  const settingsMode = state.view === 'settings';
  els.chatStream.hidden = graphMode || chainMode || ecgMode || patientMode || imageMode || settingsMode;
  els.knowledgeGraphView.hidden = !graphMode;
  els.chainSummaryView.hidden = !chainMode;
  els.ecgSamplesView.hidden = !ecgMode;
  els.patientView.hidden = !patientMode;
  els.imageViewerView.hidden = !imageMode;
  els.settingsView.hidden = !settingsMode;
  els.sendForm.hidden = graphMode || chainMode || ecgMode || patientMode || imageMode || settingsMode;
  els.transcriptScope.disabled = graphMode || chainMode || ecgMode || patientMode || imageMode;
  query('#mainTitle').textContent = graphMode ? 'Knowledge graph' : chainMode ? 'Workflow summary' : ecgMode ? 'ECG Case Explorer' : patientMode ? 'Patient view' : imageMode ? 'Image viewer' : settingsMode ? 'Settings' : 'Task orchestration';
  document.body.classList.toggle('knowledge-page', graphMode);
  document.body.classList.toggle('chain-page', chainMode);
  document.body.classList.toggle('ecg-page', ecgMode);
  document.body.classList.toggle('patient-page', patientMode);
  document.body.classList.toggle('image-page', imageMode);
  document.body.classList.toggle('settings-page', settingsMode);
  updateChatTopButton();
}

function updateChatTopButton() {
  const visible = state.view === 'chat' && !els.chatStream.hidden && els.chatStream.scrollTop > 220;
  els.chatTopBtn.classList.toggle('visible', visible);
}

function renderKnowledgeGraphTabState() {
  const graphActive = state.knowledgeGraphTab === 'graph';
  els.graphTabGraph.classList.toggle('active', graphActive);
  els.graphTabTrace.classList.toggle('active', !graphActive);
  els.graphKnowledgePanel.hidden = !graphActive;
  els.graphTracePanel.hidden = graphActive;
  if (els.graphLayout.classList.contains('graph-empty')) {
    els.graphLayout.classList.remove('info-collapsed');
    els.graphInfoPanel.hidden = true;
    els.graphInfoToggle.hidden = true;
    return;
  }
  renderGraphInfoState();
}

function renderGraphInfoState() {
  els.graphLayout.classList.toggle('info-collapsed', state.graphInfoCollapsed);
  els.graphInfoPanel.hidden = state.graphInfoCollapsed;
  els.graphInfoToggle.hidden = false;
  els.graphInfoToggle.title = state.graphInfoCollapsed ? 'Expand graph details' : 'Collapse graph details';
  els.graphInfoToggle.setAttribute('aria-label', els.graphInfoToggle.title);
}

function renderChainSummary(data: Bootstrap) {
  if (state.view !== 'chainSummary') return;
  const build = data.chainSummaryBuild || {};
  const summary = data.chainSummary || {};
  const running = Boolean(data.runtime?.chainSummaryRunning || build.running);
  const iterations = Array.isArray(summary.iterations) ? summary.iterations.length : 0;
  const metrics = Array.isArray(summary.metricSeries) ? summary.metricSeries.length : 0;
  const samples = Array.isArray(summary.iterations)
    ? summary.iterations.reduce((count: number, iteration: JsonMap) => count + (Array.isArray(iteration.sampleInspirations) ? iteration.sampleInspirations.length : 0), 0)
    : 0;
  els.buildChainSummaryBtn.disabled = running;
  const statusSignature = stableStringify({
    status: build.status || 'idle',
    running,
    message: build.message || '',
    iterations,
    metrics,
    samples,
  });
  if (statusSignature !== state.chainStatusSignature) {
    state.chainStatusSignature = statusSignature;
    els.chainBuildStatus.innerHTML = `
    <div class="chain-status-main">
      <span class="mini-pill ${build.status === 'failed' ? 'failed' : running ? 'active' : build.status === 'completed' ? 'ready' : 'pending'}">
        ${running ? '<span data-icon="Loader2"></span>' : ''}
        ${escapeHtml(running ? 'Running' : statusLabel(build.status || 'idle'))}
      </span>
      <span class="meta">${escapeHtml(chainSummaryBuildMessage(build.message || '') || 'The workflow summary reads logs and artifacts from this workspace.')}</span>
    </div>
    <div class="chain-status-stats">
      <span><strong>${escapeHtml(iterations)}</strong><small>Iteration</small></span>
      <span><strong>${escapeHtml(metrics)}</strong><small>metrics</small></span>
      <span><strong>${escapeHtml(samples)}</strong><small>Cases</small></span>
    </div>
  `;
  }
  const chartSignature = stableStringify(summary.metricSeries || []);
  if (chartSignature !== state.chainChartSignature) {
    state.chainChartSignature = chartSignature;
    renderChainMetricChart(summary.metricSeries || []);
  }
  const contentSignature = stableStringify({
    status: build.status || '',
    message: build.status === 'failed' ? build.message || '' : '',
    title: summary.title || '',
    generatedAt: summary.generatedAt || '',
    overview: summary.overview || '',
    uncertainty: summary.uncertainty || [],
    iterations: summary.iterations || [],
  });
  if (contentSignature !== state.chainContentSignature) {
    state.chainContentSignature = contentSignature;
    renderChainContent(summary, build);
  }
  renderChainNav(summary, build);
  renderChainNavState();
}

function renderChainNav(summary: JsonMap, build: JsonMap = {}) {
  const iterations: JsonMap[] = Array.isArray(summary.iterations) ? summary.iterations : [];
  const generated = build.status === 'completed' || Boolean(summary.overview) || iterations.length > 0;
  const links = [
    { target: 'chainBuildStatus', label: 'Status overview', icon: 'Activity' },
    { target: 'chain-metrics-section', label: 'Metric changes', icon: 'Gauge' },
    ...(generated ? [{ target: 'chain-overview-section', label: 'Summary overview', icon: 'Sparkles' }] : []),
    ...iterations.map((iteration, index) => ({
      target: `chain-iteration-${index + 1}`,
      label: `Round ${iterationAxisLabel(iteration.iterationId || index + 1, index)}`,
      icon: 'GitBranch',
    })),
  ];
  els.chainNavContent.innerHTML = links.map((link) => `
    <button type="button" class="chain-nav-link" data-chain-target="${escapeHtml(link.target)}">
      <span data-icon="${link.icon}"></span>
      <span>${escapeHtml(link.label)}</span>
    </button>
  `).join('');
  for (const item of els.chainNavContent.querySelectorAll<HTMLButtonElement>('[data-chain-target]')) {
    item.addEventListener('click', () => {
      const target = document.getElementById(item.dataset.chainTarget || '');
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  hydrateIcons(els.chainNavContent);
}

function renderChainNavState() {
  els.chainBody.classList.toggle('nav-collapsed', state.chainNavCollapsed);
  els.chainNav.hidden = state.chainNavCollapsed;
  els.chainNavToggle.title = state.chainNavCollapsed ? 'Expand contents' : 'Collapse contents';
  els.chainNavToggle.setAttribute('aria-label', els.chainNavToggle.title);
}

function renderChainMetricChart(series: JsonMap[]) {
  const cleaned = (series || []).filter((item) =>
    Array.isArray(item.values) && item.values.some((value: JsonMap) => Number.isFinite(Number(value.value)))
  );
  if (!cleaned.length) {
    els.chainMetricChart.innerHTML = emptyState('Key metrics across iterations will appear here.', 'Activity');
    return;
  }
  els.chainMetricChart.innerHTML = `
    <div id="chain-metrics-section" class="panel-heading chain-anchor"><span data-icon="Activity"></span><span>Metrics across iterations</span></div>
    <div class="metric-chart-grid">
      ${cleaned.map(metricChartHtml).join('')}
    </div>
  `;
}

function metricChartHtml(series: JsonMap) {
  const values = bestMetricValuesByIteration(series);
  const numeric = values.map((item) => Number(item.value)).filter((value) => Number.isFinite(value));
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const spread = max - min || 1;
  const width = Math.max(640, (values.length - 1) * 118 + 132);
  const height = 240;
  const padLeft = 58;
  const padRight = 38;
  const padTop = 48;
  const axisY = height - 52;
  const plotHeight = axisY - padTop - 22;
  const gridTicks = [0, 0.5, 1];
  const points = values.map((item, index) => {
    const value = Number(item.value);
    const x = values.length === 1 ? width / 2 : padLeft + (index * (width - padLeft - padRight)) / (values.length - 1);
    const rawY = axisY - 22 - ((value - min) / spread) * plotHeight;
    const y = Math.max(padTop, Math.min(axisY - 22, rawY));
    return {
      x,
      y,
      value,
      label: iterationAxisLabel(item.iteration, index),
      note: item.label && item.label !== item.iteration ? String(item.label) : '',
    };
  });
  const polyline = points.map((point) => `${point.x},${point.y}`).join(' ');
  return `
    <article class="metric-chart-card">
      <div class="metric-chart-title">
        <span>${escapeHtml(series.name || 'metric')}</span>
        <span class="meta">${escapeHtml(series.unit || series.direction || '')}</span>
      </div>
      <div class="metric-chart-scroll">
        <div class="metric-chart-stage" style="min-width:${width}px">
          <svg class="metric-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(series.name || 'metric')}">
            ${gridTicks.map((tick) => {
              const y = padTop + (1 - tick) * plotHeight;
              return `<line class="metric-grid-line" x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}"></line>`;
            }).join('')}
            <line class="metric-axis" x1="${padLeft}" y1="${axisY}" x2="${width - padRight}" y2="${axisY}"></line>
            ${points.map((point) => `
              <line class="metric-tick" x1="${point.x}" y1="${axisY}" x2="${point.x}" y2="${axisY + 7}"></line>
              <text class="metric-x-label" x="${point.x}" y="${axisY + 30}">${escapeHtml(point.label)}</text>
            `).join('')}
            <polyline class="metric-line" points="${polyline}"></polyline>
            ${points.map((point) => `
              <g class="metric-point" transform="translate(${point.x} ${point.y})">
                <circle r="5"></circle>
                <text y="-11">${escapeHtml(formatMetricValue(point.value))}</text>
              </g>
            `).join('')}
          </svg>
        </div>
      </div>
    </article>
  `;
}

function bestMetricValuesByIteration(series: JsonMap): JsonMap[] {
  const direction = String(series.direction || 'neutral');
  const values: JsonMap[] = (series.values || []).filter((item: JsonMap) => Number.isFinite(Number(item.value)));
  const grouped = new Map<string, JsonMap>();
  for (const item of values) {
    const key = String(item.iteration || item.label || grouped.size + 1);
    const current = grouped.get(key);
    if (!current || isBetterMetricValue(Number(item.value), Number(current.value), direction)) {
      grouped.set(key, { ...item, iteration: key });
    }
  }
  return [...grouped.values()].sort((a, b) => iterationSortKey(a.iteration) - iterationSortKey(b.iteration));
}

function isBetterMetricValue(next: number, current: number, direction: string) {
  if (direction === 'lower') return next < current;
  if (direction === 'neutral') return Math.abs(next) > Math.abs(current);
  return next > current;
}

function iterationAxisLabel(value: any, index: number) {
  const text = String(value || '').trim();
  const match = text.match(/(?:iteration|iter|it)[^\d]*(\d+)/i) || text.match(/(\d+)/);
  if (match) return String(Number(match[1]));
  return String(index + 1);
}

function iterationSortKey(value: any) {
  const match = String(value || '').match(/(\d+)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function renderChainContent(summary: JsonMap, build: JsonMap = {}) {
  const iterations: JsonMap[] = summary.iterations || [];
  const generated = build.status === 'completed';
  if (!generated) {
    els.chainSummaryContent.innerHTML = `
      <div class="chain-placeholder">
        <span data-icon="Activity"></span>
        <h3>Awaiting workflow summary</h3>
        <p>${escapeHtml(build.status === 'failed' ? chainSummaryBuildMessage(build.message || '') || 'Generation failed. Check the build log.' : 'Generate a summary from the workspace logs, reports, run records, and case visualizations.')}</p>
      </div>
    `;
    return;
  }
  if (!iterations.length && !summary.overview) {
    els.chainSummaryContent.innerHTML = emptyState('The workflow summary has no displayable content.', 'Info');
    return;
  }
  els.chainSummaryContent.innerHTML = `
    <article id="chain-overview-section" class="chain-overview chain-anchor">
      <header class="chain-overview-head">
        <div class="panel-heading"><span data-icon="Sparkles"></span><span>${escapeHtml(summary.title || 'Workflow summary')}</span></div>
        ${summary.generatedAt ? `<div class="meta">Generated ${escapeHtml(formatTime(summary.generatedAt))}</div>` : ''}
      </header>
      <div class="markdown-body chain-overview-body">${renderMarkdown(summary.overview || '')}</div>
      ${Array.isArray(summary.uncertainty) && summary.uncertainty.length ? `
        <details class="chain-uncertainty">
          <summary><span data-icon="AlertTriangle"></span><span>Risks and missing evidence</span><span class="chain-warning-count">${summary.uncertainty.length}</span></summary>
          <div class="chain-uncertainty-list">
            ${summary.uncertainty.map((item: any) => `<span><span data-icon="AlertTriangle"></span>${escapeHtml(item)}</span>`).join('')}
          </div>
        </details>
      ` : ''}
    </article>
    <div class="chain-iterations">
      ${iterations.map((iteration, index) => chainIterationHtml(iteration, index, iterations.length)).join('')}
    </div>
  `;
  for (const item of els.chainSummaryContent.querySelectorAll<HTMLElement>('[data-chain-path]')) {
    item.addEventListener('click', async () => showWorkspaceFile(item.dataset.chainPath || ''));
  }
  for (const item of els.chainSummaryContent.querySelectorAll<HTMLElement>('[data-chain-image]')) {
    item.addEventListener('click', () => openChainImage(item.dataset.chainImage || ''));
  }
}

function chainIterationHtml(iteration: JsonMap, index: number, total: number) {
  const methods: JsonMap[] = iteration.methods || [];
  const results: JsonMap[] = Array.isArray(iteration.methodResults) && iteration.methodResults.length ? iteration.methodResults : iteration.testResults || [];
  const samples: JsonMap[] = iteration.sampleInspirations || [];
  const methodRows = pairMethodResults(methods, results);
  return `
    <article id="chain-iteration-${index + 1}" class="chain-iteration-card chain-anchor">
      <header class="chain-iteration-head">
        <div class="chain-iteration-id"><span>Iteration</span>${escapeHtml(iteration.iterationId || 'iteration')}</div>
      </header>
      <section class="chain-card-section">
      <div class="detail-section-title"><span class="chain-section-index">1</span><span>Proposed methods</span></div>
      ${methodRows.length ? `<div class="chain-method-result-list">${methodRows.map(methodResultRowHtml).join('')}</div>` : emptyState('No auditable method or test result recorded.', 'Info')}
      </section>
      <section class="chain-card-section">
      <div class="detail-section-title"><span class="chain-section-index">2</span><span>Case insights</span></div>
      ${samples.length ? `<div class="chain-samples">${samples.map(chainSampleHtml).join('')}</div>` : emptyState('No case-level insight recorded.', 'Info')}
      </section>
      ${nextDecisionHtml(iteration.nextDecision || { decision: iteration.nextStep || '' })}
    </article>
    ${index < total - 1 ? `
      <div class="chain-transition-arrow" aria-label="This decision guides the next candidates">
        <span>This decision guides the next candidates</span>
        <span data-icon="ArrowDown"></span>
      </div>
    ` : ''}
  `;
}

function nextDecisionHtml(decision: JsonMap) {
  const knowledge: JsonMap[] = Array.isArray(decision.domainKnowledge) ? decision.domainKnowledge : [];
  const actions: JsonMap[] = Array.isArray(decision.actions) ? decision.actions : [];
  return `
    <section class="chain-card-section chain-next-decision">
      <div class="detail-section-title"><span class="chain-section-index">3</span><span>Next iteration decision</span><span class="chain-core-label">Decision rationale</span></div>
      <p class="chain-decision-lead">${escapeHtml(decision.decision || 'No next-iteration decision recorded.')}</p>
      ${decision.iterationEvidence ? `
        <div class="chain-decision-evidence">
          <strong>Evidence this round</strong>
          <p>${escapeHtml(decision.iterationEvidence)}</p>
        </div>
      ` : ''}
      <div class="chain-decision-subtitle">How domain knowledge guided the decision</div>
      ${knowledge.length ? `
        <div class="chain-knowledge-list">
          ${knowledge.map((item, knowledgeIndex) => `
            <article class="chain-knowledge-item">
              <span class="chain-knowledge-index">K${knowledgeIndex + 1}</span>
              <div>
                <strong>${escapeHtml(item.knowledge || 'Unnamed domain knowledge')}</strong>
                <p>${escapeHtml(item.guidance || '')}</p>
                ${item.sourcePath ? `<button type="button" class="artifact-item" data-chain-path="${escapeHtml(item.sourcePath)}"><span data-icon="File"></span><span>${escapeHtml(item.sourcePath)}</span></button>` : ''}
              </div>
            </article>
          `).join('')}
        </div>
      ` : `<div class="chain-decision-missing">${decision.legacy ? 'This older report does not connect domain knowledge to decisions. Regenerate the workflow summary.' : 'No mapping from domain knowledge to the decision was recorded.'}</div>`}
      <div class="chain-decision-subtitle">Next actions and validation</div>
      ${actions.length ? `
        <div class="chain-action-list">
          ${actions.map((item, actionIndex) => `
            <article class="chain-action-item">
              <strong>${actionIndex + 1}. ${escapeHtml(item.action || 'Unnamed action')}</strong>
              <p><span>Expected effect</span>${escapeHtml(item.expectedEffect || '')}</p>
              <p><span>Validation</span>${escapeHtml(item.validation || '')}</p>
            </article>
          `).join('')}
        </div>
      ` : `<div class="chain-decision-missing">No executable, testable next-step plan recorded.</div>`}
    </section>
  `;
}

function pairMethodResults(methods: JsonMap[], results: JsonMap[]) {
  const count = Math.max(methods.length, results.length);
  const resultByMethod = new Map<string, JsonMap>();
  for (const result of results) {
    const key = String(result.methodName || result.method || result.name || '').trim().toLowerCase();
    if (key) resultByMethod.set(key, result);
  }
  return Array.from({ length: count }, (_, index) => {
    const method = methods[index] || {};
    const key = String(method.name || '').trim().toLowerCase();
    const result = (key && resultByMethod.get(key)) || results[index] || {};
    return { method, result, index };
  });
}

function methodResultRowHtml(row: { method: JsonMap; result: JsonMap; index: number }) {
  const method = row.method || {};
  const result = row.result || {};
  const fallbackName = `Candidate ${row.index + 1}`;
  const methodName = method.name || result.methodName || result.method || fallbackName;
  const metric = result.metric || 'result';
  return `
    <div class="chain-method-result-row">
      <section class="chain-mini-card chain-method-card">
        <div class="chain-card-eyebrow">Candidate ${row.index + 1} · Method</div>
        <strong>${escapeHtml(methodName)}</strong>
        <p>${escapeHtml(method.hypothesis || '')}</p>
        ${method.artifactPath ? `<button type="button" class="artifact-item" data-chain-path="${escapeHtml(method.artifactPath)}"><span data-icon="File"></span><span>${escapeHtml(method.artifactPath)}</span></button>` : ''}
      </section>
      <section class="chain-mini-card chain-result-card">
        <div class="chain-card-eyebrow">Candidate ${row.index + 1} · Test result</div>
        <strong>${escapeHtml(metric)}${result.value ? `: ${escapeHtml(result.value)}` : ''}</strong>
        <p>${escapeHtml(result.interpretation || '')}</p>
        ${result.evidencePath ? `<button type="button" class="artifact-item" data-chain-path="${escapeHtml(result.evidencePath)}"><span data-icon="File"></span><span>${escapeHtml(result.evidencePath)}</span></button>` : ''}
      </section>
    </div>
  `;
}

function chainSampleHtml(sample: JsonMap) {
  const path = String(sample.visualizationPath || '').trim();
  const previewable = isPreviewableImage(path);
  const image = previewable
    ? `<button type="button" class="chain-sample-image-button" data-chain-image="${escapeHtml(path)}" aria-label="View ${escapeHtml(sample.sampleId || 'sample visualization')}"><img src="/api/files/preview?path=${encodeURIComponent(path)}" alt="${escapeHtml(sample.sampleId || 'sample visualization')}" loading="lazy" /></button>`
    : '';
  return `
    <article class="chain-sample-card">
      <div class="chain-sample-media">${image || `<div class="sample-image-placeholder"><span data-icon="File"></span></div>`}</div>
      <div class="chain-sample-body">
        <div class="chain-sample-title">${escapeHtml(sample.sampleId || 'sample')}</div>
        ${path ? `<button type="button" class="artifact-item" ${previewable ? `data-chain-image="${escapeHtml(path)}"` : `data-chain-path="${escapeHtml(path)}"`}><span data-icon="File"></span><span>${escapeHtml(path)}</span></button>` : ''}
        <section class="chain-sample-note">
          <span>Description</span>
          <p>${escapeHtml(sample.interpretation || 'No case description recorded.')}</p>
        </section>
        <section class="chain-sample-note impact">
          <span>Insight</span>
          <p>${escapeHtml(sample.nextIterationImpact || 'No next-step insight recorded.')}</p>
        </section>
      </div>
    </article>
  `;
}

function openChainImage(path: string) {
  const normalized = String(path || '').trim();
  if (!normalized || !isPreviewableImage(normalized)) return;
  state.selectedImagePath = normalized;
  state.view = 'imageViewer';
  history.pushState({}, '', `/image-viewer?path=${encodeURIComponent(normalized)}`);
  render();
}

function renderImageViewer() {
  const path = String(state.selectedImagePath || '').trim();
  if (!path) {
    els.imageViewerTitle.textContent = 'No image selected';
    els.imageViewerImage.removeAttribute('src');
    els.imageViewerImage.hidden = true;
    els.imageViewerPath.textContent = '';
    return;
  }
  els.imageViewerTitle.textContent = path.split('/').pop() || 'Case visualization';
  els.imageViewerImage.src = `/api/files/preview?path=${encodeURIComponent(path)}`;
  els.imageViewerImage.alt = path;
  els.imageViewerImage.hidden = false;
  els.imageViewerPath.innerHTML = `<span data-icon="File"></span><code>${escapeHtml(path)}</code>`;
}

function renderKnowledgeGraphBuilder(data: Bootstrap) {
  const build = data.knowledgeGraphBuild || {};
  const config = data.knowledgeGraphLlmConfig?.config || {};
  const running = Boolean(data.runtime?.knowledgeGraphRunning || build.running);
  const knowledgeEnabled = data.variant?.capabilities?.knowledgeGraph !== false;
  const canContinue = !running && ['paused', 'failed'].includes(String(build.status || ''));
  const hasGraph = hasKnowledgeGraph(data.knowledgeGraph);
  els.graphBuildStatus.innerHTML = `
    <span class="mini-pill ${build.status === 'failed' ? 'failed' : running ? 'active' : build.status === 'completed' ? 'ready' : 'pending'}">
      ${running ? '<span data-icon="Loader2"></span>' : ''}
      ${escapeHtml(!knowledgeEnabled ? `Disabled · ${data.variant?.id || 'variant'}` : running ? 'Running' : statusLabel(build.status || 'idle'))}
    </span>
    <span class="meta">${escapeHtml(graphBuildMessage(build.message || ''))}</span>
  `;
  if (els.graphAuthMode.value !== (config.authMode || 'manual')) els.graphAuthMode.value = config.authMode || 'manual';
  if (els.graphProtocol.value !== (config.protocol || '')) els.graphProtocol.value = config.protocol || '';
  if (els.graphModelInput.value !== (config.model || '')) els.graphModelInput.value = config.model || '';
  if (els.graphBaseUrlInput.value !== (config.baseUrl || '')) els.graphBaseUrlInput.value = config.baseUrl || '';
  els.buildGraphBtn.querySelector('span:last-child')!.textContent = hasGraph ? 'Update' : 'Build';
  els.graphLeftActions.classList.toggle('has-graph', hasGraph);
  els.buildGraphBtn.disabled = running || !knowledgeEnabled;
  els.rebuildGraphBtn.hidden = !hasGraph;
  els.rebuildGraphBtn.disabled = running || !knowledgeEnabled;
  els.continueGraphBtn.disabled = !canContinue || !knowledgeEnabled;
  els.pauseGraphBtn.disabled = !running || !knowledgeEnabled;
  els.graphExtractionDepthInput.disabled = running || !knowledgeEnabled;
  els.saveGraphLlmBtn.disabled = !knowledgeEnabled;
}

function hasKnowledgeGraph(graph: JsonMap | null | undefined) {
  if (!graph) return false;
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
  const edges = Array.isArray(graph.edges) ? graph.edges.length : 0;
  return nodes > 0 || edges > 0;
}

function renderKnowledgeWorkbench(data: Bootstrap) {
  const summary = data.knowledgeBaseSummary || data.knowledgeGraph?.summary || {};
  els.knowledgeSummary.innerHTML = `
    <div class="knowledge-depth">Depth ${escapeHtml(summary.extractionDepth ?? data.runtimeSettings?.knowledgeGraphExtractionDepth ?? 2)}</div>
    ${knowledgeStatHtml('knowledge', summary.knowledgeCount ?? 0, 'Knowledge')}
    ${knowledgeStatHtml('evidence', summary.evidenceCount ?? 0, 'Evidence')}
    ${knowledgeStatHtml('classes', summary.classCount ?? 0, 'Concepts')}
    ${knowledgeStatHtml('relations', summary.relationCount ?? 0, 'Relations')}
  `;
  for (const item of els.knowledgeSummary.querySelectorAll<HTMLButtonElement>('[data-kb-kind]')) {
    item.addEventListener('click', async () => {
      await openKnowledgeBaseCards(item.dataset.kbKind || '');
    });
  }
  renderKnowledgeBaseCards();
}

function knowledgeStatHtml(kind: string, count: any, label: string) {
  const selected = state.selectedKnowledgeBaseKind === kind ? ' selected' : '';
  return `
    <button class="knowledge-stat${selected}" type="button" data-kb-kind="${escapeHtml(kind)}">
      <span>${escapeHtml(count)}</span>
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

async function openKnowledgeBaseCards(kind: string) {
  if (!kind) return;
  state.selectedKnowledgeBaseKind = kind;
  state.knowledgeBaseCardsBusy = true;
  renderKnowledgeBaseCards();
  try {
    state.knowledgeBaseCards = await fetchJson<JsonMap>(`/api/knowledge-base/cards?kind=${encodeURIComponent(kind)}&limit=200`);
  } catch (error) {
    state.knowledgeBaseCards = {
      label: kind,
      cards: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    state.knowledgeBaseCardsBusy = false;
    renderKnowledgeBaseCards();
    hydrateIcons(els.knowledgeCards);
  }
}

function closeKnowledgeBaseCards() {
  state.selectedKnowledgeBaseKind = null;
  state.knowledgeBaseCards = null;
  state.knowledgeBaseCardsBusy = false;
  renderKnowledgeBaseCards();
}

function renderKnowledgeBaseCards() {
  if (!state.selectedKnowledgeBaseKind) {
    els.knowledgeCards.innerHTML = '';
    return;
  }
  if (state.knowledgeBaseCardsBusy) {
    els.knowledgeCards.innerHTML = `
      <div class="kb-list-head">
        <div class="node-detail-title">${escapeHtml(state.selectedKnowledgeBaseKind)}</div>
        <button class="icon-btn ghost" type="button" data-kb-close title="Close"><span data-icon="X"></span></button>
      </div>
      ${emptyState('Loading cards...', 'Loader2')}
    `;
    bindKnowledgeCardControls();
    return;
  }
  const payload = state.knowledgeBaseCards || {};
  const cards: JsonMap[] = payload.cards || [];
  els.knowledgeCards.innerHTML = `
    <div class="kb-list-head">
      <div>
        <div class="node-detail-title">${escapeHtml(payload.label || state.selectedKnowledgeBaseKind)}</div>
        <div class="meta">Showing ${escapeHtml(cards.length)}${payload.count ? ` of ${escapeHtml(payload.count)}` : ''}</div>
      </div>
      <button class="icon-btn ghost" type="button" data-kb-close title="Close"><span data-icon="X"></span></button>
    </div>
    ${payload.error ? `<div class="empty"><span data-icon="AlertTriangle"></span><span>${escapeHtml(payload.error)}</span></div>` : ''}
    ${cards.length ? `<div class="kb-cards">${cards.map(knowledgeBaseCardHtml).join('')}</div>` : emptyState('No cards yet.', 'Info')}
  `;
  bindKnowledgeCardControls();
}

function bindKnowledgeCardControls() {
  const close = els.knowledgeCards.querySelector<HTMLButtonElement>('[data-kb-close]');
  close?.addEventListener('click', closeKnowledgeBaseCards);
  for (const item of els.knowledgeCards.querySelectorAll<HTMLElement>('[data-preview-url]')) {
    item.addEventListener('click', () => {
      const previewUrl = item.dataset.previewUrl || '';
      if (previewUrl) window.open(previewUrl, '_blank', 'noopener');
    });
  }
}

function knowledgeBaseCardHtml(card: JsonMap) {
  const previewUrl = card.previewUrl || '';
  const meta = card.meta || {};
  const metaItems = Object.entries(meta)
    .filter(([, value]) => Array.isArray(value) ? value.length : value)
    .slice(0, 4);
  return `
    <article class="kb-card ${previewUrl ? 'clickable' : ''}" ${previewUrl ? `data-preview-url="${escapeHtml(previewUrl)}"` : ''}>
      <div class="kb-card-title">
        <span>${escapeHtml(card.title || card.id || 'Card')}</span>
        <span class="meta">${escapeHtml(card.id || '')}</span>
      </div>
      ${card.subtitle ? `<div class="meta">${escapeHtml(card.subtitle)}</div>` : ''}
      ${card.body ? `<p>${escapeHtml(card.body)}</p>` : ''}
      ${metaItems.length ? `<div class="graph-mini-list">${metaItems.map(([key, value]) => `<span>${escapeHtml(key)}: ${escapeHtml(Array.isArray(value) ? value.join(', ') : value)}</span>`).join('')}</div>` : ''}
    </article>
  `;
}

function renderBuilderTrace(parts: JsonMap[], target: HTMLElement = els.builderTrace) {
  const wasNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 120;
  const savedScroll = target.scrollTop;
  const visible = normalizeChatParts((parts || []).map((part) => ({ ...part, sourceLabel: 'builder' }))).slice(-80);
  if (!visible.length) {
    target.innerHTML = emptyState('No build history. Select Build to begin.', 'TerminalSquare');
    return;
  }
  target.innerHTML = visible.map((part) => messageHtml(part)).join('');
  bindToolCards(target);
  if (wasNearBottom) {
    target.scrollTop = target.scrollHeight;
  } else if (savedScroll < target.scrollHeight) {
    target.scrollTop = Math.min(savedScroll, target.scrollHeight - target.clientHeight);
  }
}

function renderKnowledgeGraph(graph: JsonMap | null | undefined) {
  const nodes: JsonMap[] = graph?.nodes || [];
  const edges: JsonMap[] = graph?.edges || [];
  els.graphTitle.textContent = graphTitleLabel(graph);
  if (!nodes.length) {
    els.graphLayout.classList.add('graph-empty');
    els.graphInfoPanel.hidden = true;
    els.graphInfoToggle.hidden = true;
    els.graphCanvas.innerHTML = graphEmptyStateHtml(graph);
    els.graphInspector.innerHTML = '';
    return;
  }
  els.graphLayout.classList.remove('graph-empty');
  renderGraphInfoState();

  const selected = nodes.find((node) => node.id === state.selectedGraphNodeId) || nodes[0];
  state.selectedGraphNodeId = selected?.id || null;
  const layout = graphNetworkLayout(nodes, edges, String(selected?.id || ''));
  const { width, height, positions, degrees, labelIds } = layout;

  els.graphCanvas.innerHTML = `
    <svg class="graph-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Knowledge graph">
      <g class="graph-edges">
        ${edges.map((edge) => {
          const source = positions.get(String(edge.source));
          const target = positions.get(String(edge.target));
          if (!source || !target) return '';
          return `<line x1="${source.x.toFixed(1)}" y1="${source.y.toFixed(1)}" x2="${target.x.toFixed(1)}" y2="${target.y.toFixed(1)}" />`;
        }).join('')}
      </g>
      <g class="graph-nodes">
        ${nodes.map((node) => {
          const position = positions.get(String(node.id));
          if (!position) return '';
          const selectedClass = node.id === state.selectedGraphNodeId ? ' selected' : '';
          const degree = degrees.get(String(node.id)) || 0;
          const radius = graphNodeRadius(degree, node.id === state.selectedGraphNodeId);
          const showLabel = labelIds.has(String(node.id));
          const label = shortGraphLabel(node.label || node.id, showLabel ? 22 : 14);
          return `
            <g class="graph-node${selectedClass}${showLabel ? ' labeled' : ''}" data-node-id="${escapeHtml(node.id)}" transform="translate(${position.x.toFixed(1)} ${position.y.toFixed(1)})">
              <title>${escapeHtml(node.label || node.id)}</title>
              <circle r="${radius.toFixed(1)}"></circle>
              ${showLabel ? `<text y="${(radius + 15).toFixed(1)}">${escapeHtml(label)}</text>` : ''}
            </g>
          `;
        }).join('')}
      </g>
    </svg>
  `;
  for (const item of els.graphCanvas.querySelectorAll<SVGGElement>('.graph-node')) {
    item.addEventListener('click', () => {
      state.selectedGraphNodeId = item.dataset.nodeId || null;
      renderKnowledgeGraph(state.bootstrap?.knowledgeGraph);
      hydrateIcons();
    });
  }
  els.graphInspector.innerHTML = graphInspectorHtml(graph, selected, nodes, edges);
  for (const item of els.graphInspector.querySelectorAll<HTMLElement>('.artifact-item')) {
    item.addEventListener('click', async () => {
      const previewUrl = item.dataset.previewUrl || '';
      if (previewUrl) {
        window.open(previewUrl, '_blank', 'noopener');
        return;
      }
      await showWorkspaceFile(item.dataset.path || '');
    });
  }
}

function graphTitleLabel(graph: JsonMap | null | undefined) {
  const raw = String(graph?.taskGoal || '').trim();
  if (!raw) return 'Reference knowledge';
  if (raw === 'Knowledge Base') return 'Reference library';
  if (raw === 'Time-Series Domain Knowledge') return 'Time-series domain knowledge';
  if (raw === 'Domain Brief: Time-Series Domain Knowledge') return 'Time-series domain knowledge';
  if (/^Domain Brief:/i.test(raw)) return raw.replace(/^Domain Brief:\s*/i, '').trim() || 'Reference knowledge';
  return raw;
}

function graphEmptyStateHtml(graph: JsonMap | null | undefined) {
  return `
    <div class="graph-empty-state" role="status" aria-live="polite">
      <div class="graph-empty-orbit" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
        <i></i>
      </div>
      <div class="graph-empty-copy">
        <div class="graph-empty-title">Knowledge graph is not built yet</div>
        <p>${escapeHtml(graphEmptyNotes(graph))}</p>
      </div>
    </div>
  `;
}

function graphEmptyNotes(graph: JsonMap | null | undefined) {
  const raw = String(graph?.notes || '').trim();
  if (!raw) return 'Select Build to extract concepts, evidence, and relations from the references.';
  if (raw === 'CSV knowledge base: evidence, knowledge, class nodes, and relation edges.') {
    return 'No concepts or relations are available yet. Select Build to create the knowledge graph.';
  }
  return raw;
}

const graphNodeTypes = ['task', 'concept', 'observable', 'method', 'metric', 'risk', 'assumption', 'data_field', 'case_pattern', 'reference'];

function graphNetworkLayout(nodes: JsonMap[], edges: JsonMap[], selectedId: string) {
  const width = 1280;
  const height = 820;
  const pad = 72;
  const centerX = width / 2;
  const centerY = height / 2;
  const ids = nodes.map((node) => String(node.id));
  const degrees = new Map<string, number>(ids.map((id) => [id, 0]));
  const adjacency = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
  for (const edge of edges) {
    const source = String(edge.source || '');
    const target = String(edge.target || '');
    if (!degrees.has(source) || !degrees.has(target)) continue;
    degrees.set(source, (degrees.get(source) || 0) + 1);
    degrees.set(target, (degrees.get(target) || 0) + 1);
    adjacency.get(source)?.add(target);
    adjacency.get(target)?.add(source);
  }

  const sorted = ids.slice().sort((a, b) => (degrees.get(b) || 0) - (degrees.get(a) || 0));
  const anchor = selectedId || sorted[0] || '';
  const simNodes = nodes.map((node, index) => {
    const id = String(node.id);
    const angle = index * 2.399963229728653;
    const radius = Math.sqrt(index + 1) * 30;
    return {
      id,
      degree: degrees.get(id) || 0,
      r: graphNodeRadius(degrees.get(id) || 0, id === anchor),
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    };
  });
  const simLinks = edges
    .map((edge) => ({ source: String(edge.source || ''), target: String(edge.target || '') }))
    .filter((edge) => degrees.has(edge.source) && degrees.has(edge.target));

  forceSimulation(simNodes as any)
    .force('link', forceLink(simLinks as any)
      .id((node: any) => node.id)
      .distance((link: any) => {
        const sourceDegree = degrees.get(String(link.source?.id || link.source)) || 0;
        const targetDegree = degrees.get(String(link.target?.id || link.target)) || 0;
        return Math.max(70, 145 - Math.min(60, (sourceDegree + targetDegree) * 3));
      })
      .strength(0.36))
    .force('charge', forceManyBody().strength((node: any) => -210 - Math.min(220, node.degree * 20)))
    .force('collide', forceCollide((node: any) => node.r + 28).strength(0.9).iterations(3))
    .force('center', forceCenter(centerX, centerY).strength(0.18))
    .force('x', forceX(centerX).strength((node: any) => node.id === anchor ? 0.08 : 0.025 + Math.min(0.045, node.degree * 0.004)))
    .force('y', forceY(centerY).strength((node: any) => node.id === anchor ? 0.08 : 0.025 + Math.min(0.045, node.degree * 0.004)))
    .stop()
    .tick(420);

  const xValues = simNodes.map((node: any) => Number(node.x));
  const yValues = simNodes.map((node: any) => Number(node.y));
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const scale = Math.min(
    1,
    (width - pad * 2) / Math.max(1, maxX - minX),
    (height - pad * 2) / Math.max(1, maxY - minY),
  );
  const offsetX = centerX - ((minX + maxX) / 2) * scale;
  const offsetY = centerY - ((minY + maxY) / 2) * scale;

  const finalPositions = new Map(simNodes.map((node: any) => {
    const x = Math.max(pad, Math.min(width - pad, node.x * scale + offsetX));
    const y = Math.max(pad, Math.min(height - pad, node.y * scale + offsetY));
    return [node.id, { x, y }];
  }));
  const labelIds = graphLabelSelection(nodes, finalPositions, degrees, anchor);

  return {
    width,
    height,
    degrees,
    labelIds,
    positions: finalPositions,
  };
}

function graphNodeRadius(degree: number, selected = false) {
  return Math.min(selected ? 34 : 30, 12 + Math.sqrt(degree + 1) * 4.4);
}

function graphLabelSelection(
  nodes: JsonMap[],
  positions: Map<string, { x: number; y: number }>,
  degrees: Map<string, number>,
  selectedId: string,
) {
  const selected = new Set<string>();
  const boxes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const candidates = nodes
    .map((node) => {
      const id = String(node.id);
      return { id, label: String(node.label || node.id || ''), degree: degrees.get(id) || 0 };
    })
    .filter((node) => positions.has(node.id) && (node.degree > 0 || node.id === selectedId))
    .sort((a, b) => (b.id === selectedId ? 1 : 0) - (a.id === selectedId ? 1 : 0) || b.degree - a.degree);

  for (const node of candidates) {
    const position = positions.get(node.id)!;
    const radius = graphNodeRadius(node.degree, node.id === selectedId);
    const label = shortGraphLabel(node.label, 22);
    const width = Math.min(164, Math.max(32, label.length * 7.2));
    const height = 17;
    const box = {
      x1: position.x - width / 2 - 5,
      y1: position.y + radius + 5,
      x2: position.x + width / 2 + 5,
      y2: position.y + radius + 5 + height,
    };
    const overlaps = boxes.some((other) =>
      box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1
    );
    if (!overlaps || node.id === selectedId) {
      selected.add(node.id);
      boxes.push(box);
    }
  }
  return selected;
}

function graphMetadataHtml(graph: JsonMap | null | undefined, nodes: JsonMap[], edges: JsonMap[]) {
  return `
    <div class="node-detail-title">Graph details</div>
    <dl class="kv graph-kv">
      <dt>Concepts</dt><dd>${nodes.length}</dd>
      <dt>Relations</dt><dd>${edges.length}</dd>
      <dt>Updated</dt><dd>${escapeHtml(graph?.updatedAt || '-')}</dd>
    </dl>
  `;
}

function graphInspectorHtml(graph: JsonMap | null | undefined, selected: JsonMap | undefined, nodes: JsonMap[], edges: JsonMap[]) {
  if (!selected) return graphMetadataHtml(graph, nodes, edges);
  const related = edges.filter((edge) => edge.source === selected.id || edge.target === selected.id);
  return `
    ${graphMetadataHtml(graph, nodes, edges)}
    <div class="detail-section-title">Selected concept</div>
    <div class="graph-selected">
      <div class="node-detail-title">${escapeHtml(selected.label || selected.id)}</div>
      <div class="meta">${escapeHtml(selected.type || 'Concepts')} · ${escapeHtml(selected.id || '')}</div>
      ${classDescriptionHtml(selected.summary || '')}
    </div>
    <div class="detail-section-title">Source knowledge</div>
    ${idListHtml(selected.knowledgeIds || [], 'Knowledge')}
    <div class="detail-section-title">Evidence</div>
    ${graphEvidenceHtml(selected.evidence || [])}
    <div class="detail-section-title">Relations</div>
    ${related.length ? `<div class="graph-relations">${related.map((edge) => `
      <div class="graph-relation">
        <div class="timeline-type">${escapeHtml(edge.relation || 'related')}</div>
        <div class="meta">${escapeHtml(edge.sourceLabel || edge.source)} -> ${escapeHtml(edge.targetLabel || edge.target)}</div>
        <div>${escapeHtml(edge.summary || '')}</div>
        ${edge.knowledgeIds?.length ? idListHtml(edge.knowledgeIds, 'Knowledge') : ''}
      </div>
    `).join('')}</div>` : emptyState('No connected edges.', 'GitBranch')}
  `;
}

function idListHtml(items: string[], label: string) {
  if (!items.length) return emptyState(`No related ${label.toLowerCase()}.`, 'Info');
  return `<div class="graph-mini-list">${items.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>`;
}

function classDescriptionHtml(summary: string) {
  if (!summary) return emptyState('No description.', 'Info');
  return `
    <details class="class-description">
      <summary>Description</summary>
      <p>${escapeHtml(summary)}</p>
    </details>
  `;
}

function graphEvidenceHtml(items: JsonMap[]) {
  if (!items.length) return emptyState('No evidence.', 'File');
  return `<div class="graph-evidence">${items.slice(0, 6).map((item) => `
    <button class="artifact-item evidence-item" type="button" data-path="${escapeHtml(item.sourcePath || '')}" data-preview-url="${escapeHtml(item.previewUrl || '')}">
      <span data-icon="File"></span>
      <span>${escapeHtml(item.sourcePath || 'Source')}: ${escapeHtml(item.quote || item.summary || '')}</span>
    </button>
  `).join('')}</div>`;
}

function shortGraphLabel(value: string, maxLength = 18) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function messageHtml(part: JsonMap) {
  const role = part.role || 'system';
  const roleClass = ['user', 'assistant', 'system', 'tool'].includes(role) ? role : 'system';
  const text = part.displayText || part.text || summarizeRaw(part.raw) || '';
  const source = part.sourceLabel ? `${sourceLabel(part.sourceLabel)} · ` : '';
  if (part.type === 'loading') {
    return `
      <article class="message assistant loading">
        <div class="message-role"><span data-icon="Loader2"></span>${escapeHtml(source)}Assistant · Running · ${formatTime(part.timestamp)}</div>
        <div class="message-text loading-line"><span>${escapeHtml(part.text)}</span></div>
      </article>
    `;
  }
  if (part.type === 'tool_call' || part.type === 'tool_use' || part.type === 'tool_result') {
    const summary = toolSummary(part);
    const detail = toolDetail(part);
    const toolName = toolNameForPart(part);
    const failed = part.status === 'failed';
    const done = !failed && (part.type === 'tool_result' || part.status === 'completed');
    const partId = String(part.id || `${part.timestamp || ''}:${toolName}:${part.type || ''}`);
    const expanded = state.expandedToolPartIds.has(partId);
    return `
      <article class="message ${escapeHtml(roleClass)} tool-collapsed${expanded ? ' expanded' : ''}" data-part-id="${escapeHtml(partId)}">
        <button class="tool-card${expanded ? ' expanded' : ''}" type="button" data-tool-toggle>
          <span class="tool-status ${failed ? 'failed' : done ? 'done' : 'running'}"><span data-icon="${failed ? 'CircleX' : done ? 'Check' : 'TerminalSquare'}"></span></span>
          <span class="tool-copy">
            <span class="tool-title">${escapeHtml(summary)}</span>
            <span class="tool-meta">${escapeHtml(source)}${escapeHtml(toolName)} · ${escapeHtml(partTypeLabel(part.type || 'tool'))} · ${formatTime(part.timestamp)}</span>
          </span>
          <span class="tool-chevron" data-icon="ChevronRight"></span>
        </button>
        <pre class="tool-detail" ${expanded ? '' : 'hidden'}>${escapeHtml(detail)}</pre>
      </article>
    `;
  }
  return `
    <article class="message ${escapeHtml(roleClass)}">
      <div class="message-role"><span data-icon="${role === 'user' ? 'Send' : role === 'assistant' ? 'Bot' : 'Info'}"></span>${escapeHtml(source)}${escapeHtml(roleLabel(role))} · ${escapeHtml(partTypeLabel(part.type || 'text'))} · ${formatTime(part.timestamp)}</div>
      <div class="message-text markdown-body">${renderMarkdown(text)}</div>
    </article>
  `;
}

function toolSummary(part: JsonMap) {
  if (part.type === 'tool_call') {
    const intend = typeof part.intend === 'string' && part.intend.trim() ? part.intend.trim() : '';
    return intend || `Call tool: ${toolNameForPart(part)}`;
  }
  if (part.type === 'tool_use') {
    const name = part.name || part.raw?.message?.content?.find?.((block: JsonMap) => block.type === 'tool_use')?.name || 'tool';
    const input = part.input || part.raw?.message?.content?.find?.((block: JsonMap) => block.type === 'tool_use')?.input;
    const intend = input?.intend;
    if (typeof intend === 'string' && intend.trim()) return intend.trim();
    const hint = input && typeof input === 'object' ? Object.keys(input).slice(0, 3).join(', ') : '';
    return hint ? `Call tool: ${name} (${hint})` : `Call tool: ${name}`;
  }
  const text = part.displayText || part.text || '';
  const firstLine = text.split('\n').find((line: string) => line.trim()) || 'Tool result';
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function toolDetail(part: JsonMap) {
  if (part.type === 'tool_call') {
    const chunks = [
      `Tool: ${toolNameForPart(part)}`,
      `Status: ${statusLabel(part.status || 'pending')}`,
      '',
      'Purpose:',
      part.intend || '',
      '',
      'Arguments:',
      JSON.stringify(part.input ?? {}, null, 2),
    ];
    if (part.status === 'completed' || part.resultText || part.resultRaw) {
      chunks.push('', 'Result:', part.resultText || toolResultTextFromRaw(part.resultRaw) || summarizeRaw(part.resultRaw) || '');
    } else {
      chunks.push('', 'Result:', 'Waiting for tool result.');
    }
    return chunks.join('\n');
  }
  return part.displayText || part.text || summarizeRaw(part.raw) || '';
}

function toolNameForPart(part: JsonMap) {
  if (part.name) return part.name;
  const toolBlock = part.raw?.message?.content?.find?.((block: JsonMap) => block.type === 'tool_use');
  return toolBlock?.name || part.raw?.tool_name || 'tool';
}

function collectTranscriptParts(data: Bootstrap): JsonMap[] {
  const scope = state.transcriptScope || 'all';
  const mainParts: JsonMap[] = (data.mainParts || []).map((part: JsonMap) => ({
    ...part,
    sourceLabel: 'main',
    sortKey: `${part.timestamp || ''}:main:${part.id || ''}`,
  }));
  const loggedUserTexts = new Set(mainParts.filter((part) => part.role === 'user' && part.text).map((part) => part.text));
  const nodeParts: JsonMap[] = [];
  const sessionsById = new Map((data.nodes || []).map((node) => [node.id, node]));
  for (const [nodeId, parts] of Object.entries(data.nodePartsById || {})) {
    const node = sessionsById.get(nodeId);
    const label = node ? `node:${node.nodeType}` : `node:${nodeId.slice(0, 8)}`;
    for (const part of parts || []) {
      nodeParts.push({
        ...part,
        nodeSessionId: nodeId,
        sourceLabel: label,
        sortKey: `${part.timestamp || ''}:node:${nodeId}:${part.id || ''}`,
      });
    }
  }
  const pendingParts = state.pendingParts
    .filter((part) => !isPendingPartLogged(part, loggedUserTexts))
    .map((part) => ({ ...part, sortKey: `${part.timestamp || ''}:pending:${part.id || ''}` }));
  if (scope === 'main') return [...mainParts, ...pendingParts].sort(sortByKey);
  if (scope.startsWith('node:')) {
    const nodeId = scope.slice('node:'.length);
    return nodeParts.filter((part) => part.nodeSessionId === nodeId || part.sortKey.includes(`:node:${nodeId}:`)).sort(sortByKey);
  }
  return [...mainParts, ...nodeParts, ...pendingParts].sort(sortByKey);
}

function collectLoadingParts(): JsonMap[] {
  const scope = state.transcriptScope || 'all';
  if (!state.loadingMessage || scope.startsWith('node:')) return [];
  return normalizeChatParts([{ ...state.loadingMessage }]);
}

function reconcilePendingParts(data: Bootstrap | null): JsonMap[] {
  if (!data) return state.pendingParts;
  const loggedUserTexts = new Set((data.mainParts || [])
    .filter((part: JsonMap) => part.role === 'user' && part.text)
    .map((part: JsonMap) => normalizePendingText(part.text)));
  const unresolved = state.pendingParts.filter((part) => !isPendingPartLogged(part, loggedUserTexts));
  return isBackendRunning(data) ? unresolved : [];
}

function isPendingPartLogged(part: JsonMap, loggedUserTexts: Set<string>): boolean {
  return Boolean(part.role === 'user' && part.text && loggedUserTexts.has(normalizePendingText(part.text)));
}

function normalizePendingText(text: string): string {
  return String(text).trim();
}

function normalizeChatParts(parts: JsonMap[]): JsonMap[] {
  return parts
    .map((part: JsonMap): JsonMap | null => {
      const failureText = protocolFailureText(part);
      if (failureText) {
        return {
          ...part,
          role: 'system',
          type: 'text',
          text: failureText,
          displayText: failureText,
        };
      }
      if (!isDisplayableSessionPart(part) || isReasoningOnlyPart(part)) return null;
      const displayText = displayTextForPart(part);
      return displayText.trim() ? { ...part, displayText } : null;
    })
    .filter((part: JsonMap | null): part is JsonMap => part !== null);
}

function isDisplayableSessionPart(part: JsonMap): boolean {
  if (part.type === 'loading') return true;
  // Semantic tool cards carry a concise intend, parameters, status, and
  // result. Raw JSON-RPC events remain implementation/audit data and are
  // hidden below.
  if (part.type === 'tool_call' || part.type === 'tool_result') return true;
  if (part.type === 'tool_use') return false;
  if (part.role === 'system' && part.type === 'raw') return false;
  // A successful SDK result is a transport marker rather than user-facing
  // content.  Failures are converted to a readable system message above.
  if (part.role === 'system' && part.type === 'result') return part.raw?.is_error === true;
  return true;
}

function protocolFailureText(part: JsonMap): string {
  const dshError = dshToolResultFailureText(part.raw);
  if (dshError) return `Tool failed: ${dshError}`;
  const toolPart = part.type === 'tool_use' || part.type === 'tool_result';
  const failed = part.status === 'failed' || part.raw?.is_error === true || part.raw?.isError === true;
  if (!toolPart || !failed) return '';
  const detail = String(part.resultText || toolResultTextFromRaw(part.raw) || part.text || '').trim();
  return detail ? `Tool failed: ${detail}` : 'Tool failed.';
}

function dshToolResultFailureText(raw: any): string {
  if (raw?.type !== 'tool/result') return '';
  const content = raw?.data?.message?.content;
  if (!Array.isArray(content)) return '';
  const failure = content.find((item: JsonMap) => item?.type === 'tool-result' && item.isError === true);
  if (!failure) return '';
  return dshContentText(failure.content) || 'No error details available.';
}

function dshContentText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((item: any) => typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function displaySafeSessionParts(parts: unknown): JsonMap[] {
  if (!Array.isArray(parts)) return [];
  return normalizeChatParts(parts as JsonMap[]).map(({ raw, resultRaw, ...part }) => part);
}

function isReasoningOnlyPart(part: JsonMap): boolean {
  if (part.role !== 'assistant' || part.type !== 'text') return false;
  if (typeof part.text === 'string' && part.text.trim()) return false;
  const content = Array.isArray(part.raw?.message?.content)
    ? part.raw.message.content
    : Array.isArray(part.raw?.content)
      ? part.raw.content
      : [];
  if (!content.length) return false;
  return content.every((item: JsonMap | string) => {
    if (typeof item === 'string') return !item.trim();
    if (!item || typeof item !== 'object') return false;
    if (typeof item.text === 'string' && item.text.trim()) return false;
    if (item.type === 'tool_use' || item.type === 'tool_result' || item.name || item.input || item.tool_use_id) return false;
    return Boolean(item.thinking || item.signature || item.redacted_thinking);
  });
}

function displayTextForPart(part: JsonMap) {
  if (part.type === 'loading') return part.text || 'Running';
  if (part.type === 'tool_call') {
    return part.intend || `Call tool: ${toolNameForPart(part)}`;
  }
  if (part.type === 'tool_use') {
    const name = part.name || part.raw?.message?.content?.find?.((block: JsonMap) => block.type === 'tool_use')?.name || 'tool';
    const input = part.input || part.raw?.message?.content?.find?.((block: JsonMap) => block.type === 'tool_use')?.input;
    return input ? `Call tool: ${name}\n${JSON.stringify(input, null, 2)}` : `Call tool: ${name}`;
  }
  if (part.type === 'tool_result') {
    const result = part.raw?.tool_use_result;
    if (result?.filenames) {
      const files = result.filenames.slice(0, 20).join('\n');
      const more = result.truncated ? `\n... (${result.numFiles} files total)` : '';
      return result.filenames.length ? `Tool result:\n${files}${more}` : 'Tool result: No files found';
    }
    const rawText = toolResultTextFromRaw(part.raw);
    if (rawText) return rawText;
    return part.text === 'Tool result' ? '' : part.text || '';
  }
  if (part.role === 'system' && part.type === 'raw') {
    const subtype = part.raw?.subtype || part.text || '';
    if (subtype === 'api_retry') return `API retry: attempt ${part.raw?.attempt ?? '?'}/${part.raw?.max_retries ?? '?'}`;
    return subtype;
  }
  if (part.role === 'system' && part.type === 'result') {
    if (part.raw?.is_error) return part.raw?.result || part.text || 'Error';
    return '';
  }
  return part.text || '';
}

function renderTimeline(events: JsonMap[]) {
  const savedScroll = els.timeline.scrollTop;
  if (!events.length) {
    els.timeline.innerHTML = emptyState('No workflow history.', 'Clock3');
    return;
  }
  els.timeline.innerHTML = events.slice(-80).reverse().map((event) => `
    <button class="timeline-item" type="button">
      <span class="timeline-dot"></span>
      <span class="timeline-copy">
        <span class="timeline-type">${escapeHtml(event.type)} ${event.nodeType ? `· ${escapeHtml(event.nodeType)}` : ''}</span>
        <span class="meta">${formatTime(event.timestamp)}</span>
        <span>${escapeHtml(event.message || '')}</span>
      </span>
    </button>
  `).join('');
  els.timeline.scrollTop = Math.min(savedScroll, els.timeline.scrollHeight - els.timeline.clientHeight);
}

function renderFileTree(fileTree: Bootstrap['fileTree']) {
  renderWorkspaceDatasetControl();
  if (!fileTree?.tree) {
    els.workspacePath.textContent = '';
    els.fileTree.innerHTML = emptyState('No workspace files.', 'FolderTree');
    return;
  }
  els.workspacePath.textContent = fileTree.root || '';
  els.fileTree.innerHTML = renderTreeNode(fileTree.tree, true);
  if (fileTree.truncated) {
    const limit = fileTree.maxChildrenPerDir
      ? `(up to ${fileTree.maxChildrenPerDir} items per folder, ${fileTree.maxDepth || 5} levels)`
      : '';
    els.fileTree.insertAdjacentHTML('beforeend', emptyState(`Some folders are truncated${limit}.`, 'AlertTriangle'));
  }
  for (const item of els.fileTree.querySelectorAll<HTMLElement>('.file-node.file')) {
    item.addEventListener('click', async () => showWorkspaceFile(item.dataset.path || ''));
  }
}

function renderWorkspaceDatasetControl() {
  if (!els.workspaceDatasetSelect) return;
  els.workspaceDatasetSelect.innerHTML = state.ecgDatasets.map((dataset: JsonMap) => {
    return `<option value="${escapeHtml(dataset.key)}">${escapeHtml(dataset.name || dataset.key)}</option>`;
  }).join('');
  if (state.ecgDatasetKey) els.workspaceDatasetSelect.value = state.ecgDatasetKey;
  els.workspaceDatasetSelect.disabled = state.ecgDatasets.length <= 1;
}

function renderTreeNode(node: FileTreeNode | undefined, root = false): string {
  if (!node) return '';
  if (node.kind === 'dir') {
    const open = root || ['user', 'artifacts', 'data', 'tools', 'runs', 'reports'].includes(node.path);
    const truncation = node.truncated
      ? `<div class="file-tree-note">${escapeHtml(fileTreeTruncationText(node))}</div>`
      : '';
    return `
      <details class="file-dir" ${open ? 'open' : ''}>
        <summary><span data-icon="ChevronRight"></span><span>${escapeHtml(node.name || 'Workspace')}</span></summary>
        <div class="file-children">
          ${(node.children || []).map((child) => renderTreeNode(child)).join('')}
          ${truncation}
        </div>
      </details>
    `;
  }
  return `
    <button class="file-node file" data-path="${escapeHtml(node.path)}">
      <span class="file-label"><span data-icon="File"></span><span>${escapeHtml(node.name)}</span></span>
      <span class="file-size">${formatBytes(node.size || 0)}</span>
    </button>
  `;
}

function fileTreeTruncationText(node: FileTreeNode) {
  if ((node.childCount || 0) > (node.maxChildren || 0)) {
    return `Showing first ${node.maxChildren} of ${node.childCount} items`;
  }
  return `Maximum display depth: ${node.maxDepth || 5} levels`;
}

async function showWorkspaceFile(path: string) {
  if (!path) return;
  try {
    const file = await fetchJson<JsonMap>(`/api/files/content?path=${encodeURIComponent(path)}`);
    if (file.binary) {
      showDetail(path, { message: 'Binary file preview is not supported.', size: file.size }, path);
      return;
    }
    if (file.truncated) {
      showDetail(path, { message: 'File is too large to preview.', size: file.size }, path);
      return;
    }
    showTextDetail(path, file.text || '', path);
  } catch (error) {
    showDetail(path, { message: error instanceof Error ? error.message : String(error) });
  }
}

function updateControls(data: Bootstrap) {
  const ws = data.state || {};
  const activeSession = getActiveNodeSession(data);
  const activePaused = Boolean(ws.activeNode && activeSession?.status === 'paused');
  const activeRunning = Boolean(ws.activeNode && activeSession?.status === 'running');
  const executionPhase = String(data.execution?.phase || 'ready');
  const pauseWaiting = executionPhase === 'pausing';
  const pendingControl = Boolean(ws.pendingControl);
  els.sendBtn.disabled = state.busy || (Boolean(ws.activeNode) && !activePaused);
  els.messageInput.disabled = state.busy || (Boolean(ws.activeNode) && !activePaused);
  els.messageInput.placeholder = activePaused
    ? 'Add a clarification, then select Resume to continue the current stage'
    : 'Message the task orchestrator';
  els.interruptBtn.disabled = pauseWaiting || (!state.busy && !activeRunning);
  els.interruptBtn.hidden = !state.busy && !activeRunning;
  els.forceStopBtn.hidden = executionPhase !== 'pausing';
  els.uploadBtn.disabled = state.busy;
  els.rawZipUploadBtn.disabled = state.busy;
  els.approveControlBtn.disabled = state.busy || !pendingControl;
  els.rejectControlBtn.disabled = state.busy || !pendingControl;
  updateSendButton(activePaused);
}

function getActiveNodeSession(data: Bootstrap) {
  const ws = data.state || {};
  if (!ws.activeNodeSessionId) return null;
  return (data.nodes || []).find((node) => node.id === ws.activeNodeSessionId) || null;
}

async function runAction(fn: () => Promise<void>) {
  state.busy = true;
  render();
  try {
    await fn();
  } catch (error) {
    showDetail('Error', { message: error instanceof Error ? error.message : String(error) });
  } finally {
    state.busy = false;
    render();
  }
}

async function runStreamingAction(fn: () => Promise<void>) {
  state.busy = true;
  render();
  await nextPaint();
  try {
    await fn();
  } catch (error) {
    state.busy = false;
    state.loadingMessage = null;
    render();
    showDetail('Error', { message: error instanceof Error ? error.message : String(error) });
  }
}

function emptyBootstrap(): Bootstrap {
  return {
    state: { activeNode: null, completedNodes: [] },
    mainParts: [],
    nodePartsById: {},
    nodes: [],
    nodeSpecs: [],
    timeline: [],
    fileTree: null,
    runtime: { running: false, workspaceUv: null },
  };
}

function variantPill(variant: JsonMap | null | undefined) {
  if (!variant?.id) return '<span class="mini-pill pending">-</span>';
  const id = String(variant.id).toUpperCase();
  const label = `${id} · ${variantNameLabel(variant)}`;
  const isDefault = id === 'NOD-KGR-KTL-CRV-SUB-ADA';
  const features = Array.isArray(variant.features) ? `Features: ${variant.features.join(', ')}` : '';
  const title = [variant.description || label, features].filter(Boolean).join('\n');
  return `<span class="mini-pill variant-pill ${isDefault ? 'variant-default' : 'variant-ablation'}" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
}

function variantNameLabel(variant: JsonMap) {
  const id = String(variant.id || '').toUpperCase();
  if (id === 'NOD-KGR-KTL-CRV-SUB-ADA') return 'Full workflow';
  return String(variant.name || 'Unnamed workflow');
}

function formatRuntimeUv(runtimeUv: JsonMap | null | undefined) {
  if (!runtimeUv) return '-';
  const runtimeState = runtimeUv.state || 'unknown';
  if (runtimeState === 'ready') return `Ready · Python ${runtimeUv.pythonVersion || ''}`.trim();
  if (runtimeState === 'skipped') return 'Skipped';
  if (runtimeState === 'failed') return 'Failed';
  return runtimeState;
}

function runtimePill(runtimeUv: JsonMap | null | undefined) {
  const text = formatRuntimeUv(runtimeUv);
  const tone = text.startsWith('Ready') ? 'ready' : text === 'Failed' ? 'failed' : 'pending';
  return `<span class="mini-pill ${tone}">${escapeHtml(text)}</span>`;
}

function statusPill(text: string, tone: string) {
  return `<span class="mini-pill ${tone}">${escapeHtml(text)}</span>`;
}

function statusIcon(status: string) {
  const icon = status === 'done' ? 'Check' : status === 'active' ? 'Loader2' : status === 'failed' ? 'XCircle' : 'Circle';
  return `<span data-icon="${icon}"></span>`;
}

function statusLabel(status: any) {
  const value = String(status || 'idle');
  if (value === 'done' || value === 'completed' || value === 'ready') return 'Complete';
  if (value === 'active' || value === 'running' || value === 'building') return 'Running';
  if (value === 'failed') return 'Failed';
  if (value === 'paused') return 'Paused';
  if (value === 'waiting_approval') return 'Awaiting approval';
  if (value === 'pending') return 'Pending';
  if (value === 'idle') return 'Idle';
  return value;
}

function modeLabel(mode: any) {
  const value = String(mode || '-');
  if (value === 'auto') return 'Auto';
  if (value === 'manual') return 'Manual';
  return value;
}

function graphBuildMessage(message: string) {
  if (!message) return '';
  if (message === 'Knowledge graph updated.') return 'Knowledge graph updated.';
  return message;
}

function chainSummaryBuildMessage(message: string) {
  if (!message) return '';
  if (message === 'Chain summary updated.') return 'Workflow summary updated.';
  return message;
}

function nodeDisplayName(type: any) {
  const value = String(type || '');
  if (value === 'problem-contract') return 'Problem definition';
  if (value === 'knowledge-to-tools') return 'Knowledge to tools';
  if (value === 'iterative-solving') return 'Iterative solving';
  if (value === 'final-summary') return 'Final summary';
  return value;
}

function nodePurposeText(spec: JsonMap) {
  const type = String(spec?.type || '');
  if (type === 'problem-contract') return 'Explore the data and references, define the task, and record the evaluation contract.';
  if (type === 'knowledge-to-tools') return 'Build and validate deterministic reference feature extractors for case review.';
  if (type === 'iterative-solving') return 'Propose, test, and review candidates in each iteration before selecting the next action.';
  if (type === 'final-summary') return 'Summarize the experiments, selected tools, results, and limitations.';
  return String(spec?.purpose || '');
}

function nodePhaseLabel(phase: any) {
  const value = String(phase || '');
  if (value === 'setup') return 'Setup';
  if (value === 'solve') return 'Solve';
  if (value === 'iteration') return 'Iteration';
  if (value === 'summary') return 'Summary';
  return value;
}

function roleLabel(role: any) {
  const value = String(role || '');
  if (value === 'user') return 'User';
  if (value === 'assistant') return 'Assistant';
  if (value === 'system') return 'System';
  return value;
}

function partTypeLabel(type: any) {
  const value = String(type || '');
  if (value === 'text') return 'Text';
  if (value === 'tool_call') return 'Tool call';
  if (value === 'tool_use') return 'Tool use';
  if (value === 'tool_result') return 'Tool result';
  if (value === 'tool') return 'Tool';
  if (value === 'loading') return 'Running';
  if (value === 'raw') return 'Raw event';
  if (value === 'result') return 'Result';
  return value;
}

function sourceLabel(source: any) {
  const value = String(source || '');
  if (value === 'main') return 'Main session';
  if (value === 'builder') return 'Builder';
  if (value === 'harness') return 'System';
  if (value.startsWith('node:')) return `Stage: ${nodeDisplayName(value.slice(5))}`;
  return value;
}

function emptyState(text: string, icon = 'Info') {
  return `<div class="empty"><span data-icon="${icon}"></span><span>${escapeHtml(text)}</span></div>`;
}

function renderMarkdown(text: string) {
  const html = marked.parse(text || '', { async: false }) as string;
  return DOMPurify.sanitize(html);
}

function bindToolCards(root: HTMLElement = els.chatStream) {
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-tool-toggle]')) {
    button.addEventListener('click', () => {
      const detail = button.nextElementSibling as HTMLElement | null;
      if (!detail) return;
      const expanded = detail.hidden === true;
      detail.hidden = !expanded;
      const article = button.closest<HTMLElement>('.tool-collapsed');
      const partId = article?.dataset.partId;
      if (partId) {
        if (expanded) state.expandedToolPartIds.add(partId);
        else state.expandedToolPartIds.delete(partId);
      }
      article?.classList.toggle('expanded', expanded);
      button.classList.toggle('expanded', expanded);
      if (expanded) requestAnimationFrame(() => article?.scrollIntoView({ block: 'nearest' }));
    });
  }
}

function renderShellState() {
  document.body.classList.toggle('left-collapsed', state.leftCollapsed);
  document.body.classList.toggle('right-collapsed', state.rightCollapsed);
  els.leftRailToggle.title = state.leftCollapsed ? 'Expand left sidebar' : 'Collapse left sidebar';
  els.rightRailToggle.title = state.rightCollapsed ? 'Expand right sidebar' : 'Collapse right sidebar';
  const leftIcon = state.leftCollapsed ? 'ChevronRight' : 'ChevronLeft';
  const rightIcon = state.rightCollapsed ? 'ChevronLeft' : 'ChevronRight';
  if (els.leftRailToggle.dataset.currentIcon !== leftIcon) {
    els.leftRailToggle.dataset.currentIcon = leftIcon;
    els.leftRailToggle.innerHTML = `<span data-icon="${leftIcon}"></span>`;
    hydrateIcons(els.leftRailToggle);
  }
  if (els.rightRailToggle.dataset.currentIcon !== rightIcon) {
    els.rightRailToggle.dataset.currentIcon = rightIcon;
    els.rightRailToggle.innerHTML = `<span data-icon="${rightIcon}"></span>`;
    hydrateIcons(els.rightRailToggle);
  }
}

function autosizeComposer() {
  els.messageInput.style.height = 'auto';
  const maxHeight = Math.round(window.innerHeight * 0.3);
  els.messageInput.style.height = `${Math.min(els.messageInput.scrollHeight, maxHeight)}px`;
}

function updateSendButton(activePaused = false) {
  const hasText = Boolean(els.messageInput.value.trim());
  const canSend = hasText && !els.messageInput.disabled && !state.busy;
  els.sendBtn.disabled = !canSend;
  els.sendBtn.hidden = !els.interruptBtn.hidden;
  const icon = state.busy ? 'Square' : activePaused ? 'Play' : 'ArrowUp';
  if (els.sendBtn.dataset.currentIcon !== icon) {
    els.sendBtn.dataset.currentIcon = icon;
    els.sendBtn.innerHTML = `<span data-icon="${icon}"></span>`;
    hydrateIcons(els.sendBtn);
  }
  els.sendBtn.title = activePaused ? 'Resume current stage' : 'Send';
  els.sendBtn.classList.toggle('ready', canSend);
}

function loadingPart(text: string) {
  return {
    id: `loading-${Date.now()}`,
    timestamp: new Date().toISOString(),
    role: 'assistant',
    type: 'loading',
    text,
    sourceLabel: 'harness',
  };
}

function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function pauseCurrent(reason: string) {
  els.interruptBtn.disabled = true;
  try {
    await postJson('/api/execution/pause', { reason });
    state.loadingMessage = loadingPart('Pausing and saving a checkpoint');
    render();
    const settled = await waitForRealtimeState((data) => ['paused', 'failed'].includes(data.execution?.phase || ''));
    if (settled.execution?.phase === 'failed') {
      throw new Error(settled.execution.lastError || 'DSH pause failed.');
    }
    state.loadingMessage = null;
    state.pendingParts = reconcilePendingParts(state.bootstrap);
    render();
  } catch (error) {
    state.loadingMessage = null;
    render();
    showDetail('Pause failed', { message: error instanceof Error ? error.message : String(error) });
  } finally {
    els.interruptBtn.disabled = false;
    updateControls(state.bootstrap || emptyBootstrap());
  }
}

async function postSend(text: string): Promise<any> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await postJson('/api/send', { text });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isPausedResumeSettling(message)) break;
      state.loadingMessage = loadingPart('Resuming; retrying message');
      try {
        await waitForRealtimeState((data) => !data.runtime?.running, 2500);
      } catch {
        await sleep(300);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isPausedResumeSettling(message: string): boolean {
  if (state.bootstrap?.execution?.phase !== 'paused') return false;
  return message.includes('still settling') || message.includes('already active');
}

async function waitForBackendIdle(timeoutMs: number) {
  await waitForRealtimeState((data) => !data.runtime?.running, timeoutMs);
}

function waitForRealtimeState(predicate: (data: Bootstrap) => boolean, timeoutMs?: number) {
  if (state.bootstrap && predicate(state.bootstrap)) return Promise.resolve(state.bootstrap);
  return new Promise<Bootstrap>((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      reject,
      timer: timeoutMs === undefined ? null : window.setTimeout(() => {
          state.realtimeWaiters = state.realtimeWaiters.filter((candidate) => candidate !== waiter);
          reject(new Error('Timed out waiting for a realtime state update.'));
        }, timeoutMs),
    };
    state.realtimeWaiters.push(waiter);
  });
}

function resolveRealtimeWaiters(data: Bootstrap) {
  for (const waiter of [...state.realtimeWaiters]) {
    if (!waiter.predicate(data)) continue;
    if (waiter.timer !== null) window.clearTimeout(waiter.timer);
    state.realtimeWaiters = state.realtimeWaiters.filter((candidate) => candidate !== waiter);
    waiter.resolve(data);
  }
}

function isActiveNodePaused(data: Bootstrap | null): boolean {
  if (!data?.state?.activeNodeSessionId) return false;
  const node = (data.nodes || []).find((item) => item.id === data.state.activeNodeSessionId);
  return node?.status === 'paused';
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function showDetail(title: string, value: any, path = '') {
  els.dialogTitle.textContent = title;
  els.dialogBody.textContent = JSON.stringify(value ?? null, null, 2);
  updateReferenceDeleteButton(path);
  els.dialog.showModal();
}

function showTextDetail(title: string, text: string, path = '') {
  els.dialogTitle.textContent = title;
  els.dialogBody.textContent = text;
  updateReferenceDeleteButton(path);
  els.dialog.showModal();
}

function updateReferenceDeleteButton(path: string) {
  const normalized = String(path || '').trim().replace(/^\/+/, '');
  const deletable = isReferenceFilePath(normalized);
  els.deleteReferenceBtn.hidden = !deletable;
  els.deleteReferenceBtn.dataset.path = deletable ? normalized : '';
}

function isReferenceFilePath(path: string) {
  return path.startsWith('references/') && !path.endsWith('/');
}

function summarizeRaw(raw: any) {
  if (!raw) return '';
  if (raw.subtype) return raw.subtype;
  if (raw.type) return raw.type;
  return JSON.stringify(raw);
}

function toolResultTextFromRaw(raw: any): string {
  const content = raw?.message?.content ?? raw?.content;
  return extractToolResultText(content);
}

function extractToolResultText(value: any): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim()) parts.push(item.trim());
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (typeof item.text === 'string' && item.text.trim()) {
      parts.push(item.text.trim());
      continue;
    }
    const nested = extractToolResultText(item.content);
    if (nested) parts.push(nested);
  }
  return parts.join('\n');
}

function formatMetricValue(value: number) {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function isPreviewableImage(path: string) {
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(path);
}

function formatTime(value: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function unique(values: any[]) {
  return [...new Set(values.filter(Boolean))];
}

function resetChainRenderSignatures() {
  state.chainStatusSignature = '';
  state.chainChartSignature = '';
  state.chainContentSignature = '';
}

function stableStringify(value: any) {
  return JSON.stringify(value ?? null);
}

function sortByKey(a: JsonMap, b: JsonMap) {
  return String(a.sortKey || '').localeCompare(String(b.sortKey || ''));
}

function escapeHtml(value: any) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function query<T extends Element = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

function hydrateIcons(root: ParentNode = document) {
  for (const holder of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    if (holder.dataset.iconHydrated === 'true') continue;
    const name = holder.dataset.icon || '';
    const iconNode = iconMap[name];
    if (!iconNode) continue;
    const svg = createIcon(iconNode);
    holder.replaceChildren(svg);
    holder.dataset.iconHydrated = 'true';
  }
}

function createIcon(iconNode: IconNode) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of iconNode) {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, String(value));
    svg.appendChild(child);
  }
  return svg;
}

connectRealtimeEvents();
if (state.view === 'ecgSamples') void loadEcgOverview();
else if (state.view === 'patient') void loadPatientOverview();
else void loadEcgDatasets();
