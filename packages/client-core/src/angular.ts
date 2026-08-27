import {
  HttpClient,
  HttpErrorResponse,
  HttpEventType,
  HttpHeaders,
  HttpResponse
} from "@angular/common/http";
import type { HttpDownloadProgressEvent } from "@angular/common/http";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  InjectionToken,
  computed,
  effect,
  inject,
  makeEnvironmentProviders,
  signal,
  viewChild,
  type EnvironmentProviders,
  type OnDestroy,
  type OnInit
} from "@angular/core";
import { firstValueFrom, fromEvent, takeUntil } from "rxjs";
import type {
  AiAppAssistantAccessView,
  AiAppAssistantResponse
} from "@123toto/ai-app-assistant-contracts";
import {
  createAiAppAssistantClient,
  type AiAppAssistantClient,
  type AiAppAssistantStreamTransport
} from "./client.js";
import {
  AiAppAssistantController,
  normalizeAiAppAssistantError as normalizeError,
  type AiAppAssistantControllerConfig,
  type AiAppAssistantControllerMessage,
  type AiAppAssistantControllerState
} from "./controller.js";
import {
  createAiAppAssistantSettingsClient,
  type AiAppAssistantSettingsClient
} from "./settings.js";
import {
  defineAiAppAssistantSettingsElement,
  type AiAppAssistantSettingsElement,
  type AiAppAssistantSettingsTheme
} from "./settings-web-component.js";

/** Configuration for the Angular connector and its ready-to-use assistant. */
export interface AiAppAssistantAngularConfig extends AiAppAssistantControllerConfig {
  endpoint: string;
  streamEndpoint?: string;
  /** Enables access discovery and the optional administration screen. */
  managedEndpoint?: string;
  headers?: () => HeadersInit | Promise<HeadersInit>;
  assistantName?: string;
  launcherLabel?: string;
  subtitle?: string;
  /**
   * Visual tokens consumed by the generic assistant. CSS variables are valid,
   * which lets a host application follow its own live theme without coupling
   * this connector to a particular design system.
   */
  theme?: Partial<AiAppAssistantTheme>;
  /** @deprecated Prefer `theme.accent`. */
  accentColor?: string;
  mascot?: string;
  /** Optional copy overrides; defaults follow the document language (French or English). */
  labels?: Partial<AiAppAssistantUiLabels>;
  settings?: AiAppAssistantAngularSettingsConfig;
}

export interface AiAppAssistantAngularSettingsConfig {
  title?: string;
  /** Defaults to document.body. Useful when theme variables live on an application shell. */
  container?: () => HTMLElement | null;
  confirmRevoke?: () => boolean | Promise<boolean>;
  theme?: Partial<AiAppAssistantSettingsTheme>;
}

/** Small provider-neutral palette used by the ready-to-use assistant. */
export interface AiAppAssistantTheme {
  accent: string;
  accentContrast: string;
  header: string;
  headerText: string;
  launcher: string;
  launcherText: string;
  surface: string;
  surfaceMuted: string;
  text: string;
  textMuted: string;
  border: string;
  selection: string;
  selectionText: string;
  danger: string;
}

export interface AiAppAssistantUiLabels {
  selectionInstruction: string;
  cancel: string;
  newConversation: string;
  detach: string;
  dock: string;
  minimize: string;
  welcomeTitle: string;
  welcomeBody: string;
  reliability: string;
  retrying: string;
  reading: string;
  thinking: string;
  writing: string;
  finalizing: string;
  stop: string;
  errorTitle: string;
  retry: string;
  placeholder: string;
  select: string;
  elementSelected: string;
  mediumConfidence: string;
  lowConfidence: string;
  insufficientConfidence: string;
  conversationLimitReached: string;
  send: string;
}

const AI_APP_ASSISTANT_CLIENT = new InjectionToken<AiAppAssistantClient>("AI_APP_ASSISTANT_CLIENT");
const AI_APP_ASSISTANT_CONFIG = new InjectionToken<AiAppAssistantAngularConfig>("AI_APP_ASSISTANT_CONFIG");
const AI_APP_ASSISTANT_SETTINGS_CLIENT = new InjectionToken<AiAppAssistantSettingsClient | undefined>("AI_APP_ASSISTANT_SETTINGS_CLIENT");

/** Registers the generic client while preserving Angular HTTP interceptors. */
export function provideAiAppAssistant(config: AiAppAssistantAngularConfig): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: AI_APP_ASSISTANT_CONFIG, useValue: config },
    {
      provide: AI_APP_ASSISTANT_CLIENT,
      useFactory: () => {
        const http = inject(HttpClient);
        return createAiAppAssistantClient({
          endpoint: config.endpoint,
          ...(config.streamEndpoint ? { streamEndpoint: config.streamEndpoint } : {}),
          transport: async (request, options) => {
            if (options.signal?.aborted) throw abortReason(options.signal);
            const response$ = http.post<unknown>(options.endpoint, request, {
              headers: toHttpHeaders(await config.headers?.())
            });
            return firstValueFrom(options.signal
              ? response$.pipe(takeUntil(fromEvent(options.signal, "abort")))
              : response$);
          },
          streamTransport: createAngularStreamTransport(http, config)
        });
      }
    },
    {
      provide: AI_APP_ASSISTANT_SETTINGS_CLIENT,
      useFactory: () => {
        if (!config.managedEndpoint) return undefined;
        return createAiAppAssistantSettingsClient({
          endpoint: config.managedEndpoint,
          fetch: createAngularFetch(inject(HttpClient))
        });
      }
    },
    {
      provide: AiAppAssistantService,
      useFactory: () => new AiAppAssistantService(
        inject(AI_APP_ASSISTANT_CONFIG),
        inject(AI_APP_ASSISTANT_CLIENT),
        inject(AI_APP_ASSISTANT_SETTINGS_CLIENT)
      )
    },
    {
      provide: AiAppAssistantSettingsService,
      useFactory: () => new AiAppAssistantSettingsService(
        inject(AI_APP_ASSISTANT_CONFIG),
        inject(AI_APP_ASSISTANT_SETTINGS_CLIENT),
        inject(AiAppAssistantService)
      )
    }
  ]);
}

export type AiAppAssistantState = AiAppAssistantControllerState;
export type AiAppAssistantConversationMessage = AiAppAssistantControllerMessage;

/** Angular state, conversation and cancellable DOM-selection facade. */
export class AiAppAssistantService {
  readonly #state = signal<AiAppAssistantState>({ status: "idle" });
  readonly #messages = signal<AiAppAssistantConversationMessage[]>([]);
  readonly #selecting = signal(false);
  readonly #selectedElementLabel = signal<string | undefined>(undefined);
  readonly #loading = signal(false);
  readonly #maxConversationTurns = signal(3);
  readonly #conversationTurns = signal(0);
  readonly #conversationLimitReached = signal(false);
  readonly #available = signal(false);
  readonly state = this.#state.asReadonly();
  readonly messages = this.#messages.asReadonly();
  readonly selecting = this.#selecting.asReadonly();
  readonly loading = this.#loading.asReadonly();
  readonly selectedElementLabel = this.#selectedElementLabel.asReadonly();
  readonly maxConversationTurns = this.#maxConversationTurns.asReadonly();
  readonly conversationTurns = this.#conversationTurns.asReadonly();
  readonly conversationLimitReached = this.#conversationLimitReached.asReadonly();
  readonly available = this.#available.asReadonly();
  readonly config: Readonly<AiAppAssistantAngularConfig>;
  readonly #controller: AiAppAssistantController;

  public constructor(
    config: AiAppAssistantAngularConfig,
    client: AiAppAssistantClient,
    readonly settingsClient?: AiAppAssistantSettingsClient
  ) {
    this.config = config;
    this.#available.set(!config.managedEndpoint);
    this.#controller = new AiAppAssistantController(config, client);
    this.#controller.subscribe((snapshot) => {
      this.#state.set(snapshot.state);
      this.#messages.set([...snapshot.messages]);
      this.#selecting.set(snapshot.selecting);
      this.#selectedElementLabel.set(snapshot.selectedElementLabel);
      this.#loading.set(snapshot.loading);
      this.#maxConversationTurns.set(snapshot.maxConversationTurns);
      this.#conversationTurns.set(snapshot.conversationTurns);
      this.#conversationLimitReached.set(snapshot.conversationLimitReached);
    });
    if (config.managedEndpoint) void this.refreshAccess();
  }

  /** Refreshes launcher visibility and the server-defined conversation limit. */
  public async refreshAccess(): Promise<AiAppAssistantAccessView | undefined> {
    if (!this.config.managedEndpoint) {
      this.#available.set(true);
      return undefined;
    }
    try {
      if (!this.settingsClient) throw new Error("Managed AI App Assistant client is unavailable");
      const access = await this.settingsClient.getAccess();
      this.#available.set(access.available);
      this.setMaxConversationTurns(access.maxConversationTurns);
      if (!access.available) {
        this.#controller.stop();
        this.#controller.cancelElementSelection();
      }
      return access;
    } catch {
      this.#available.set(false);
      return undefined;
    }
  }

  /** Captures the page and asks without application-specific DOM annotations. */
  public async ask(options: { question?: string; selectedElement?: Element } = {}): Promise<AiAppAssistantResponse> {
    return this.#controller.ask(options);
  }

  /** Starts selection only. Asking remains a separate user action. */
  public async selectElement(): Promise<Element> {
    return this.#controller.selectElement();
  }

  /** Backward-compatible shortcut; prefer selectElement followed by ask. */
  public async selectAndAsk(question: string, options?: { signal?: AbortSignal }): Promise<AiAppAssistantResponse> {
    return this.#controller.selectAndAsk(question, options);
  }

  public cancelElementSelection(): void { this.#controller.cancelElementSelection(); }

  public clearSelectedElement(): void { this.#controller.clearSelectedElement(); }

  /** Aborts the active provider call without erasing the conversation. */
  public stop(): void { this.#controller.stop(); }

  /** Replays the last prompt after automatic retries have been exhausted. */
  public retry(): Promise<AiAppAssistantResponse> { return this.#controller.retry(); }

  /** Explicitly clears conversation and selection; minimizing does not. */
  public newConversation(): void { this.#controller.newConversation(); }

  /** Resets automatically when the application's page URL changes. */
  public syncPage(key?: string): boolean { return this.#controller.syncPage(key); }

  public reset(): void { this.#controller.reset(); }

  /** Applies a host-provided runtime limit without recreating the assistant. */
  public setMaxConversationTurns(value: number): void {
    this.#controller.setMaxConversationTurns(value);
  }
}

/** Opens the framework-neutral settings UI with Angular's authenticated HttpClient. */
export class AiAppAssistantSettingsService {
  #element: AiAppAssistantSettingsElement | undefined;

  public constructor(
    readonly config: AiAppAssistantAngularConfig,
    readonly client: AiAppAssistantSettingsClient | undefined,
    readonly assistant: AiAppAssistantService
  ) {}

  /** Lazily creates and opens the generic settings element. */
  public open(): void {
    if (!this.config.managedEndpoint || !this.client) {
      throw new Error("Set managedEndpoint before opening AI App Assistant settings.");
    }
    const element = this.element();
    element.show();
  }

  public close(): void { this.#element?.close(); }

  /** Creates one shared element and refreshes launcher access after changes. */
  private element(): AiAppAssistantSettingsElement {
    if (this.#element?.isConnected) return this.#element;
    defineAiAppAssistantSettingsElement();
    const element = document.createElement("ai-app-assistant-settings") as AiAppAssistantSettingsElement;
    const settingsTheme = compactTheme({
      accent: this.config.theme?.accent,
      accentContrast: this.config.theme?.accentContrast,
      header: this.config.theme?.header,
      headerText: this.config.theme?.headerText,
      surface: this.config.theme?.surface,
      surfaceMuted: this.config.theme?.surfaceMuted,
      text: this.config.theme?.text,
      textMuted: this.config.theme?.textMuted,
      border: this.config.theme?.border,
      danger: this.config.theme?.danger,
      ...this.config.settings?.theme
    });
    element.configure({
      endpoint: this.config.managedEndpoint!,
      client: this.client!,
      title: this.config.settings?.title ?? "AI assistant settings",
      ...(this.config.settings?.confirmRevoke
        ? { confirmRevoke: this.config.settings.confirmRevoke }
        : {}),
      theme: settingsTheme
    });
    const configurationChanged = (): void => {
      element.close();
      void this.assistant.refreshAccess();
    };
    element.addEventListener("ai-app-assistant-settings-saved", configurationChanged);
    element.addEventListener("ai-app-assistant-key-revoked", configurationChanged);
    (this.config.settings?.container?.() ?? document.body).append(element);
    this.#element = element;
    return element;
  }
}

/** Complete standalone UI. Add `<ai-app-assistant />` near the app root. */
@Component({
  selector: "ai-app-assistant",
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    "data-ai-app-assistant-ui": "",
    "[style.display]": "service.available() ? null : 'none'",
    "[style.--ai-accent]": "theme().accent",
    "[style.--ai-accent-contrast]": "theme().accentContrast",
    "[style.--ai-header]": "theme().header",
    "[style.--ai-header-text]": "theme().headerText",
    "[style.--ai-launcher]": "theme().launcher",
    "[style.--ai-launcher-text]": "theme().launcherText",
    "[style.--ai-surface]": "theme().surface",
    "[style.--ai-surface-muted]": "theme().surfaceMuted",
    "[style.--ai-text]": "theme().text",
    "[style.--ai-text-muted]": "theme().textMuted",
    "[style.--ai-border]": "theme().border",
    "[style.--ai-selection]": "theme().selection",
    "[style.--ai-selection-text]": "theme().selectionText",
    "[style.--ai-danger]": "theme().danger"
  },
  template: `
    @if (!open()) {
      <button class="ai-launcher" type="button" (click)="show()" [attr.aria-label]="launcherLabel()">
        <span class="ai-launcher-orbit" aria-hidden="true"><span class="ai-avatar">{{ mascot() }}</span><i class="ai-star ai-star-one" (animationiteration)="randomizeStar($event)">✦</i><i class="ai-star ai-star-two" (animationiteration)="randomizeStar($event)">✦</i><i class="ai-star ai-star-three" (animationiteration)="randomizeStar($event)">✦</i></span><span class="ai-launcher-label">{{ launcherLabel() }}</span>
      </button>
    }
    @if (service.selecting()) {
      <div class="ai-selection-hud" role="status"><span>{{ labels().selectionInstruction }}</span><kbd>Esc</kbd><button type="button" (click)="cancelSelection()">{{ labels().cancel }}</button></div>
    }
    @if (open()) {
      <aside class="ai-panel" [class.ai-docked]="docked()" [style.left.px]="left()" [style.top.px]="top()" aria-label="Assistant de documentation" aria-live="polite">
        <header class="ai-header" (pointerdown)="startDrag($event)">
          <div class="ai-identity"><span class="ai-avatar" aria-hidden="true">{{ mascot() }}</span><div><strong>{{ assistantName() }}</strong><small>{{ subtitle() }}</small></div></div>
          <div class="ai-window-actions">
            <button type="button" [attr.aria-label]="labels().newConversation" [title]="labels().newConversation" (pointerdown)="$event.stopPropagation()" (click)="newConversation()">↻</button>
            <button type="button" [title]="docked() ? labels().detach : labels().dock" (pointerdown)="$event.stopPropagation()" (click)="toggleDock()">{{ docked() ? '↗' : '↘' }}</button>
            <button type="button" [title]="labels().minimize" (pointerdown)="$event.stopPropagation()" (click)="open.set(false)">—</button>
          </div>
        </header>
        <main #conversationContent class="ai-content">
          @if (service.messages().length === 0 && service.state().status === 'idle') {
            <div class="ai-welcome"><span aria-hidden="true">{{ mascot() }}</span><div><strong>{{ labels().welcomeTitle }}</strong><p>{{ labels().welcomeBody }}</p></div></div>
          }
          @for (message of service.messages(); track message.id) {
            @if (message.role === 'selection') {
              <article class="ai-selection-event" [attr.data-ai-message-id]="message.id"><span class="ai-selection-icon">✦</span><div><small>{{ labels().elementSelected }}</small><strong>{{ message.label }}</strong></div><i>✦</i><i>✦</i></article>
            } @else if (message.role === 'user') {
              <article class="ai-message ai-user" [attr.data-ai-message-id]="message.id"><p>{{ message.text }}</p></article>
            } @else {
              <article class="ai-message ai-assistant" [attr.data-ai-message-id]="message.id">
                @if (message.response.answer.title) { <h3>{{ message.response.answer.title }}</h3> }
                <p>{{ message.response.answer.summary }}</p>
                @for (section of message.response.answer.sections; track section.heading) { <section><h4>{{ section.heading }}</h4><p>{{ section.content }}</p></section> }
                @if (message.response.answer.steps?.length) { <ol>@for (step of message.response.answer.steps; track step.label) { <li><strong>{{ step.label }}</strong> {{ step.description }}</li> }</ol> }
                @for (warning of message.response.answer.warnings ?? []; track warning) { <p class="ai-warning">⚠ {{ warning }}</p> }
                <footer><span class="ai-confidence"><i class="ai-confidence-dot" [class]="confidenceClass(message.response)" aria-hidden="true"></i>{{ labels().reliability }}: {{ confidencePercent(message.response) }} %</span>@if (confidenceNotice(message.response); as notice) { <small class="ai-confidence-note">{{ notice }}</small> }@for (limitation of visibleLimitations(message.response); track limitation) { <small>{{ limitation }}</small> }</footer>
              </article>
            }
          }
          @if (service.state(); as state) {
            @if (state.status === 'loading') {
              <article class="ai-message ai-assistant ai-progress-message">
                @if (state.partialText) { <p class="ai-stream-text">{{ state.partialText }}</p> }
                <div class="ai-progress" role="status"><span class="ai-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>{{ progressLabel(state.phase) }}</span></div>
                @if (state.retry) { <small>{{ labels().retrying }} {{ state.retry.attempt }}/{{ state.retry.maxRetries }}…</small> }
              </article>
            } @else if (state.status === 'error') {
              <div class="ai-error"><strong>{{ labels().errorTitle }}</strong><span>{{ state.error.message }}</span>@if (state.canRetry) { <button type="button" (click)="retry()">{{ labels().retry }}</button> }</div>
            }
          }
        </main>
        <form class="ai-composer" (submit)="submit($event)">
          @if (service.conversationLimitReached()) { <div class="ai-conversation-limit"><span>{{ labels().conversationLimitReached }}</span><button type="button" (click)="newConversation()">{{ labels().newConversation }}</button></div> }
          @if (service.selectedElementLabel(); as label) { <div class="ai-selection-chip"><span>◎ {{ label }}</span><button type="button" aria-label="Retirer la sélection" (click)="clearSelection()">×</button></div> }
          <textarea rows="2" maxlength="4000" [value]="question()" [disabled]="service.loading() || service.conversationLimitReached()" [placeholder]="labels().placeholder" (input)="updateQuestion($event)" (keydown)="composerKeydown($event)"></textarea>
          <div class="ai-composer-actions"><button class="ai-select" type="button" [disabled]="service.loading() || service.conversationLimitReached()" (click)="beginSelection()">◎ {{ labels().select }}</button>@if (service.loading()) { <button class="ai-send ai-stop-control" type="button" [attr.aria-label]="labels().stop" [title]="labels().stop" (click)="service.stop()">■</button> } @else { <button class="ai-send" type="submit" [disabled]="service.conversationLimitReached()" [attr.aria-label]="labels().send">➤</button> }</div>
        </form>
      </aside>
    }
  `,
  styles: [`
    :host{font:14px/1.45 system-ui,sans-serif;color:#202624}button,textarea{font:inherit}.ai-launcher{position:fixed;right:20px;bottom:20px;z-index:9000;display:flex;align-items:center;width:48px;height:48px;padding:0;color:#fff;font-weight:650;background:linear-gradient(135deg,var(--ai-accent),#0f5947);border:0;border-radius:50%;box-shadow:0 8px 24px #0003;cursor:pointer;transition:width .22s ease,border-radius .22s ease,box-shadow .22s ease;animation:ai-beacon 9s ease-in-out infinite}.ai-launcher:hover,.ai-launcher:focus-visible{width:142px;border-radius:999px;box-shadow:0 10px 30px #0004,0 0 0 4px color-mix(in srgb,var(--ai-accent) 16%,transparent);animation:none}.ai-launcher-orbit{position:relative;display:grid;flex:0 0 48px;height:48px;overflow:hidden;place-items:center}.ai-launcher-orbit:before,.ai-launcher-orbit:after{position:absolute;z-index:2;content:'✦';color:#eafff9;line-height:1;text-shadow:0 0 7px #fff;opacity:0;pointer-events:none;animation:ai-sparkle 3.8s ease-in-out infinite}.ai-launcher-orbit:before{font-size:12px}.ai-launcher-orbit:after{font-size:7px;animation-delay:1.15s}.ai-launcher .ai-avatar{background:transparent}.ai-launcher-label{max-width:0;overflow:hidden;opacity:0;white-space:nowrap;transform:translateX(-5px);transition:max-width .22s ease,opacity .15s ease,transform .22s ease}.ai-launcher:hover .ai-launcher-label,.ai-launcher:focus-visible .ai-launcher-label{max-width:86px;opacity:1;transform:none}.ai-avatar{display:grid;width:32px;height:32px;place-items:center;background:#ffffff26;border-radius:50%}.ai-panel{position:fixed;z-index:9100;display:flex;flex-direction:column;width:min(390px,calc(100vw - 24px));height:min(600px,calc(100vh - 32px));min-width:310px;min-height:380px;overflow:hidden;background:#fff;border:1px solid #dce3e0;border-radius:16px;box-shadow:0 18px 55px #1c332b38;resize:both}.ai-panel.ai-docked{top:auto!important;right:16px;bottom:16px;left:auto!important;height:min(600px,calc(100vh - 32px));resize:both}.ai-header{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;color:#fff;background:linear-gradient(135deg,var(--ai-accent),#0f5947);cursor:move;touch-action:none}.ai-identity{display:flex;align-items:center;gap:9px;min-width:0}.ai-identity div{display:flex;flex-direction:column;min-width:0}.ai-identity small{overflow:hidden;opacity:.78;text-overflow:ellipsis;white-space:nowrap}.ai-window-actions{display:flex;gap:1px}.ai-window-actions button{width:28px;height:28px;color:#fff;background:transparent;border:0;border-radius:8px;cursor:pointer}.ai-window-actions button:hover{background:#ffffff26}.ai-content{flex:1 1 auto;min-height:0;padding:14px;overflow:auto;background:#f6f8f7}.ai-welcome{display:flex;gap:10px;padding:13px;background:#e9f4ef;border:1px solid #d6e9e0;border-radius:12px}.ai-welcome p{margin:4px 0 0;color:#57635e}.ai-message{width:fit-content;max-width:92%;margin:0 0 11px;padding:10px 12px;border-radius:13px;box-shadow:0 2px 9px #20382f12}.ai-message p{margin:0 0 8px;white-space:pre-wrap}.ai-message p:last-child{margin-bottom:0}.ai-user{margin-left:auto;color:#fff;background:var(--ai-accent);border-bottom-right-radius:4px}.ai-user small{display:block;margin-bottom:5px;opacity:.78}.ai-assistant{background:#fff;border:1px solid #e0e6e3;border-bottom-left-radius:4px}.ai-assistant h3,.ai-assistant h4{margin:0 0 6px;font-size:14px}.ai-assistant section{margin-top:10px}.ai-assistant footer{display:flex;flex-direction:column;gap:3px;margin:10px -12px -10px;padding:8px 12px;color:#69736f;font-size:11px;font-style:italic;border-top:1px solid #edf0ef}.ai-warning{color:#8b5c00}.ai-stream-text{white-space:pre-wrap}.ai-streaming:after{content:'▋';color:var(--ai-accent);animation:blink 1s steps(1) infinite}.ai-dots{display:inline-flex;gap:3px}.ai-dots i{width:5px;height:5px;background:var(--ai-accent);border-radius:50%;animation:pulse 1s infinite alternate}.ai-dots i:nth-child(2){animation-delay:.2s}.ai-dots i:nth-child(3){animation-delay:.4s}.ai-link{display:block;padding:6px 0 0;color:var(--ai-accent);background:none;border:0;cursor:pointer}.ai-error{display:flex;flex-direction:column;gap:7px;padding:12px;color:#7e2525;background:#fff0f0;border:1px solid #f2cece;border-radius:12px}.ai-error button{align-self:flex-start;padding:6px 10px;color:#fff;background:#a43737;border:0;border-radius:8px;cursor:pointer}.ai-composer{flex:0 0 auto;padding:9px;background:#fff;border-top:1px solid #e0e6e3}.ai-composer textarea{box-sizing:border-box;width:100%;min-height:48px;padding:9px 10px;resize:none;color:inherit;background:#f8faf9;border:1px solid #d7dfdc;border-radius:10px;outline:0}.ai-composer textarea:focus{border-color:var(--ai-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ai-accent) 15%,transparent)}.ai-composer-actions{display:flex;justify-content:space-between;margin-top:7px}.ai-composer-actions button{border-radius:9px;cursor:pointer}.ai-select{padding:6px 9px;color:var(--ai-accent);background:#fff;border:1px solid #ccd8d3}.ai-send{width:34px;height:32px;color:#fff;background:var(--ai-accent);border:0}button:disabled,textarea:disabled{opacity:.55;cursor:default}.ai-selection-chip{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px;padding:5px 8px;color:#175844;background:#e7f4ee;border-radius:9px}.ai-selection-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ai-selection-chip button{color:inherit;background:none;border:0;cursor:pointer}.ai-selection-hud{position:fixed;top:16px;left:50%;z-index:2147483646;display:flex;align-items:center;gap:10px;padding:9px 12px;color:#fff;background:#18231f;border-radius:12px;box-shadow:0 10px 35px #0005;transform:translateX(-50%)}.ai-selection-hud kbd{padding:2px 5px;background:#ffffff20;border-radius:4px}.ai-selection-hud button{color:#fff;background:transparent;border:1px solid #ffffff55;border-radius:7px;cursor:pointer}@media(max-width:575px){.ai-panel,.ai-panel.ai-docked{inset:auto 8px 8px!important;width:calc(100vw - 16px);height:min(600px,calc(100vh - 16px));min-width:0;min-height:360px;border-radius:14px;resize:none}.ai-selection-hud{width:calc(100vw - 24px);justify-content:center}}@media(prefers-reduced-motion:reduce){.ai-launcher,.ai-launcher-orbit:before,.ai-launcher-orbit:after{animation:none}}@keyframes ai-beacon{0%,91%,100%{transform:translateY(0)}94%{transform:translateY(-4px)}97%{transform:translateY(0)}98.5%{transform:translateY(-2px)}}@keyframes ai-sparkle{0%,58%,100%{opacity:0;transform:translate(-15px,14px) scale(.45)}68%{opacity:1}82%{opacity:.85;transform:translate(14px,-13px) scale(1.05)}88%{opacity:0;transform:translate(18px,-17px) scale(.5)}}@keyframes blink{50%{opacity:0}}@keyframes pulse{to{opacity:.25;transform:translateY(-2px)}}
  `, `
    .ai-launcher{animation-duration:14s}.ai-launcher-orbit:before,.ai-launcher-orbit:after{display:none}.ai-star{position:absolute;z-index:2;color:#effffb;font-style:normal;line-height:1;text-shadow:0 0 7px #fff;opacity:0;pointer-events:none}.ai-star-one{font-size:11px;animation:ai-snow-one 6.8s ease-in-out infinite}.ai-star-two{font-size:7px;animation:ai-snow-two 8.1s ease-in-out 1.7s infinite}.ai-star-three{font-size:9px;animation:ai-snow-three 7.4s ease-in-out 3.4s infinite}.ai-identity small{max-width:220px;overflow:visible;line-height:1.18;text-overflow:clip;white-space:normal}.ai-selection-event{position:relative;display:flex;align-items:center;gap:10px;max-width:92%;margin:0 0 11px;padding:10px 12px;overflow:hidden;color:#155a45;background:linear-gradient(135deg,#effbf6,#dff5eb);border:1px solid #9dd8c2;border-radius:13px;box-shadow:0 7px 22px #14745b25;animation:ai-selection-arrive .55s cubic-bezier(.2,1.35,.4,1)}.ai-selection-event div{display:flex;flex-direction:column;min-width:0}.ai-selection-event small{color:#527268}.ai-selection-event strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ai-selection-event>i{position:absolute;color:#fff;font-style:normal;text-shadow:0 0 7px var(--ai-accent);animation:ai-selection-glint 1.35s ease-out both}.ai-selection-event>i:nth-last-child(2){right:28px;bottom:4px}.ai-selection-event>i:last-child{top:4px;right:8px;font-size:8px;animation-delay:.18s}.ai-selection-icon{display:grid;flex:0 0 28px;height:28px;place-items:center;color:#fff;background:var(--ai-accent);border-radius:50%;box-shadow:0 0 0 5px #14745b16}.ai-progress-message{min-width:190px}.ai-progress{display:flex;align-items:center;gap:8px;color:#50625b}.ai-progress-star{display:grid;width:24px;height:24px;place-items:center;color:#fff;background:var(--ai-accent);border-radius:50%;animation:ai-thinking 1.8s ease-in-out infinite}.ai-stop-control{background:#34443e}.ai-confidence-note{padding:8px 9px;color:#725400;background:#fff8dc;border-left:3px solid #d4a800;border-radius:7px}.ai-streaming:after{content:none}@media(prefers-reduced-motion:reduce){.ai-star,.ai-selection-event,.ai-selection-event>i,.ai-progress-star{animation:none}}@keyframes ai-snow-one{0%,56%,100%{opacity:0;transform:translate(-17px,18px) rotate(-12deg) scale(.55)}65%{opacity:1}84%{opacity:.9;transform:translate(13px,-14px) rotate(14deg) scale(1.05)}91%{opacity:0;transform:translate(18px,-20px) rotate(23deg) scale(.55)}}@keyframes ai-snow-two{0%,48%,100%{opacity:0;transform:translate(-8px,20px) rotate(8deg) scale(.4)}59%{opacity:.9}78%{opacity:.75;transform:translate(17px,-9px) rotate(-18deg) scale(1)}86%{opacity:0;transform:translate(21px,-15px) scale(.5)}}@keyframes ai-snow-three{0%,63%,100%{opacity:0;transform:translate(-20px,9px) rotate(-20deg) scale(.45)}72%{opacity:1}87%{opacity:.8;transform:translate(9px,-18px) rotate(20deg) scale(1.08)}94%{opacity:0;transform:translate(15px,-22px) scale(.5)}}@keyframes ai-selection-arrive{from{opacity:0;transform:translateY(22px) scale(.78);filter:blur(4px)}to{opacity:1;transform:none;filter:none}}@keyframes ai-selection-glint{from{opacity:0;transform:translate(-22px,14px) scale(.4)}45%{opacity:1}to{opacity:0;transform:translate(8px,-10px) scale(1.3)}}@keyframes ai-thinking{0%,100%{box-shadow:0 0 0 0 #14745b45;transform:rotate(0)}50%{box-shadow:0 0 0 6px #14745b0f;transform:rotate(22deg)}}
  `, `
    :host{--ai-accent:#14745b;--ai-accent-contrast:#fff;--ai-header:linear-gradient(135deg,var(--ai-accent),color-mix(in srgb,var(--ai-accent) 70%,#000));--ai-header-text:var(--ai-accent-contrast);--ai-launcher:var(--ai-header);--ai-launcher-text:var(--ai-header-text);--ai-surface:#fff;--ai-surface-muted:#f6f8f7;--ai-text:#202624;--ai-text-muted:#69736f;--ai-border:#dce3e0;--ai-selection:#eef0ff;--ai-selection-text:#303b82;--ai-danger:#a43737;color:var(--ai-text)}
    .ai-launcher{color:var(--ai-launcher-text);background:var(--ai-launcher);box-shadow:0 8px 24px #0003,0 0 0 1px color-mix(in srgb,var(--ai-launcher) 55%,transparent),0 0 18px color-mix(in srgb,var(--ai-launcher) 48%,transparent)}
    .ai-launcher:hover,.ai-launcher:focus-visible{box-shadow:0 10px 30px #0004,0 0 0 3px color-mix(in srgb,var(--ai-launcher) 24%,transparent),0 0 24px color-mix(in srgb,var(--ai-launcher) 58%,transparent)}
    .ai-panel{color:var(--ai-text);background:var(--ai-surface);border-color:var(--ai-border)}
    .ai-header{color:var(--ai-header-text);background:var(--ai-header)}
    .ai-window-actions button{color:var(--ai-header-text)}
    .ai-content{background:var(--ai-surface-muted)}
    .ai-welcome{background:color-mix(in srgb,var(--ai-accent) 9%,var(--ai-surface));border-color:color-mix(in srgb,var(--ai-accent) 20%,var(--ai-border))}
    .ai-welcome p,.ai-progress{color:var(--ai-text-muted)}
    .ai-progress{gap:9px}.ai-progress .ai-dots{align-items:center;height:16px;gap:4px}.ai-progress .ai-dots i{width:5px;height:5px;background:var(--ai-accent);animation:ai-wave 1.05s ease-in-out infinite}.ai-progress .ai-dots i:nth-child(2){animation-delay:.14s}.ai-progress .ai-dots i:nth-child(3){animation-delay:.28s}
    .ai-user{color:var(--ai-accent-contrast)}
    .ai-assistant{color:var(--ai-text);background:var(--ai-surface);border-color:var(--ai-border)}
    .ai-assistant>h3{margin:0 0 10px;padding:0 0 8px;font-size:15px;font-weight:650;line-height:1.3;border-bottom:1px solid var(--ai-border)}
    .ai-assistant section{margin-top:14px;padding-top:11px;border-top:1px solid color-mix(in srgb,var(--ai-border) 72%,transparent)}
    .ai-assistant section h4{margin:0 0 6px;font-size:13px;font-weight:650;line-height:1.3}
    .ai-assistant p,.ai-assistant li{font-weight:350;line-height:1.48}
    .ai-assistant ol{margin:12px 0 0;padding-left:20px}.ai-assistant li+li{margin-top:7px}
    .ai-assistant footer{color:var(--ai-text-muted);border-color:var(--ai-border)}
    .ai-composer{color:var(--ai-text);background:var(--ai-surface);border-color:var(--ai-border)}
    .ai-composer textarea{color:var(--ai-text);background:var(--ai-surface-muted);border-color:var(--ai-border)}
    .ai-select{color:var(--ai-accent);background:var(--ai-surface);border-color:var(--ai-border)}
    .ai-send,.ai-progress-star{color:var(--ai-header-text);background:var(--ai-header)}
    .ai-selection-chip,.ai-selection-event{color:var(--ai-selection-text);background:var(--ai-selection);border-color:color-mix(in srgb,var(--ai-selection-text) 25%,var(--ai-border))}
    .ai-selection-event{box-shadow:0 7px 22px color-mix(in srgb,var(--ai-selection-text) 15%,transparent)}
    .ai-selection-event small{color:color-mix(in srgb,var(--ai-selection-text) 72%,var(--ai-text-muted))}
    .ai-selection-icon{color:var(--ai-accent-contrast);background:var(--ai-selection-text);box-shadow:0 0 0 5px color-mix(in srgb,var(--ai-selection-text) 10%,transparent)}
    .ai-error{color:var(--ai-danger);background:color-mix(in srgb,var(--ai-danger) 9%,var(--ai-surface));border-color:color-mix(in srgb,var(--ai-danger) 28%,var(--ai-border))}
    .ai-error button{background:var(--ai-danger)}
    .ai-confidence{display:inline-flex;align-items:center;gap:5px;color:var(--ai-text);font-style:normal}
    .ai-confidence-dot{display:inline-block;width:8px;height:8px;background:#8b9490;border-radius:50%;box-shadow:0 0 0 2px color-mix(in srgb,currentColor 10%,transparent)}
    .ai-confidence-dot.ai-confidence-high{background:#238636}.ai-confidence-dot.ai-confidence-medium{background:#d29922}.ai-confidence-dot.ai-confidence-low{background:#da3633}.ai-confidence-dot.ai-confidence-insufficient{background:#8b9490}
    .ai-confidence-note{padding:0;color:var(--ai-text-muted);background:none;border:0;border-radius:0;font-size:11px;font-style:italic}
    .ai-conversation-limit{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px;padding:7px 8px;color:var(--ai-text-muted);background:var(--ai-surface-muted);border:1px solid var(--ai-border);border-radius:9px;font-size:12px}.ai-conversation-limit button{flex:0 0 auto;padding:4px 7px;color:var(--ai-accent);background:var(--ai-surface);border:1px solid var(--ai-border);border-radius:7px;cursor:pointer}
    .ai-star{--ai-dx0:2px;--ai-dy0:-1px;--ai-dx1:-2px;--ai-dy1:1px;--ai-dx2:1px;--ai-dy2:2px;color:var(--ai-launcher-text);text-shadow:0 0 6px var(--ai-launcher-text)}.ai-star-one{--ai-x0:-13px;--ai-y0:-10px;--ai-x1:11px;--ai-y1:-12px;--ai-x2:3px;--ai-y2:10px;font-size:10px;animation:ai-star-twinkle 10.9s ease-in-out infinite}.ai-star-two{--ai-x0:14px;--ai-y0:8px;--ai-x1:-11px;--ai-y1:-12px;--ai-x2:14px;--ai-y2:-3px;font-size:7px;animation:ai-star-twinkle 12.7s ease-in-out -3.1s infinite}.ai-star-three{--ai-x0:-14px;--ai-y0:-5px;--ai-x1:7px;--ai-y1:8px;--ai-x2:-4px;--ai-y2:-14px;font-size:8px;animation:ai-star-twinkle 11.8s ease-in-out -6.4s infinite}
    @media(prefers-color-scheme:dark){:host{--ai-surface:#1d2321;--ai-surface-muted:#151a18;--ai-text:#edf2ef;--ai-text-muted:#aab5b0;--ai-border:#39443f;--ai-selection:#252949;--ai-selection-text:#c9d0ff;--ai-danger:#ff7b72}}
    @keyframes ai-star-twinkle{0%,3%{opacity:0;transform:translate(var(--ai-x0),var(--ai-y0)) scale(.15)}6%{opacity:.38;transform:translate(var(--ai-x0),var(--ai-y0)) scale(.42)}10%{opacity:1;transform:translate(var(--ai-x0),var(--ai-y0)) scale(1.18)}14%{opacity:.45;transform:translate(calc(var(--ai-x0) + var(--ai-dx0)),calc(var(--ai-y0) + var(--ai-dy0))) scale(.58)}17%{opacity:0;transform:translate(calc(var(--ai-x0) + var(--ai-dx0)),calc(var(--ai-y0) + var(--ai-dy0))) scale(.15)}18%,41%{opacity:0;transform:translate(var(--ai-x1),var(--ai-y1)) scale(.15)}44%{opacity:.34;transform:translate(var(--ai-x1),var(--ai-y1)) scale(.4)}48%{opacity:.92;transform:translate(var(--ai-x1),var(--ai-y1)) scale(1.12)}52%{opacity:.4;transform:translate(calc(var(--ai-x1) + var(--ai-dx1)),calc(var(--ai-y1) + var(--ai-dy1))) scale(.55)}55%{opacity:0;transform:translate(calc(var(--ai-x1) + var(--ai-dx1)),calc(var(--ai-y1) + var(--ai-dy1))) scale(.15)}56%,78%{opacity:0;transform:translate(var(--ai-x2),var(--ai-y2)) scale(.15)}81%{opacity:.36;transform:translate(var(--ai-x2),var(--ai-y2)) scale(.42)}85%{opacity:.96;transform:translate(var(--ai-x2),var(--ai-y2)) scale(1.16)}89%{opacity:.42;transform:translate(calc(var(--ai-x2) + var(--ai-dx2)),calc(var(--ai-y2) + var(--ai-dy2))) scale(.57)}93%,100%{opacity:0;transform:translate(calc(var(--ai-x2) + var(--ai-dx2)),calc(var(--ai-y2) + var(--ai-dy2))) scale(.15)}}
    @keyframes ai-wave{0%,60%,100%{opacity:.4;transform:translateY(0)}30%{opacity:1;transform:translateY(-4px)}}
    @media(prefers-reduced-motion:reduce){.ai-star,.ai-progress .ai-dots i{animation:none}}
  `]
})
export class AiAppAssistantComponent implements OnInit, OnDestroy {
  public readonly service = inject(AiAppAssistantService);
  public readonly open = signal(false);
  public readonly docked = signal(true);
  public readonly left = signal<number | null>(null);
  public readonly top = signal<number | null>(16);
  public readonly question = signal("");
  public readonly assistantName = computed(() => this.service.config.assistantName ?? "AI guide");
  public readonly launcherLabel = computed(() => this.service.config.launcherLabel ?? "Ask AI");
  public readonly subtitle = computed(() => this.service.config.subtitle ?? "Help about this page");
  public readonly mascot = computed(() => this.service.config.mascot ?? "✦");
  public readonly theme = computed<Partial<AiAppAssistantTheme>>(() => ({
    ...this.service.config.theme,
    ...(this.service.config.theme?.accent || !this.service.config.accentColor
      ? {}
      : { accent: this.service.config.accentColor })
  }));
  public readonly labels = computed<AiAppAssistantUiLabels>(() => ({
    ...(document.documentElement.lang.toLowerCase().startsWith("fr") ? FRENCH_LABELS : ENGLISH_LABELS),
    ...this.service.config.labels
  }));
  private readonly conversationContent = viewChild<ElementRef<HTMLElement>>("conversationContent");
  private routeTimer: ReturnType<typeof setInterval> | undefined;
  private dragCleanup: (() => void) | undefined;
  private scrollFrame: number | undefined;
  private scrollKey = "";
  /** Keeps the latest question and the start of its answer in view. */
  private readonly keepLatestTurnVisible = effect(() => {
    const open = this.open();
    const messages = this.service.messages();
    const status = this.service.state().status;
    const content = this.conversationContent();
    if (!open || !content) {
      this.scrollKey = "";
      return;
    }
    const lastMessage = messages.at(-1);
    const anchorMessage = lastMessage?.role === "selection"
      ? lastMessage
      : [...messages].reverse().find((message) => message.role === "user");
    if (!anchorMessage) return;
    const nextKey = `${anchorMessage.id}:${lastMessage?.id ?? ""}:${status}`;
    // Partial streaming updates keep the same key: the viewport remains on the
    // question and opening lines instead of chasing the end of a long answer.
    if (nextKey === this.scrollKey) return;
    this.scrollKey = nextKey;
    if (this.scrollFrame !== undefined) cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = requestAnimationFrame(() => {
      const element = content.nativeElement;
      const anchor = element.querySelector<HTMLElement>(
        `[data-ai-message-id="${anchorMessage.id}"]`
      );
      this.scrollFrame = undefined;
      if (!anchor) return;
      const top = element.scrollTop
        + anchor.getBoundingClientRect().top
        - element.getBoundingClientRect().top
        - 6;
      element.scrollTo({
        top: Math.max(0, top),
        behavior: "smooth"
      });
    });
  });

  public ngOnInit(): void {
    this.routeTimer = setInterval(() => {
      if (this.service.syncPage()) this.question.set("");
    }, 500);
  }
  public ngOnDestroy(): void {
    if (this.routeTimer) clearInterval(this.routeTimer);
    if (this.scrollFrame !== undefined) cancelAnimationFrame(this.scrollFrame);
    this.dragCleanup?.(); this.service.stop(); this.service.cancelElementSelection();
  }
  public show(): void {
    if (this.service.syncPage()) this.question.set("");
    this.open.set(true);
  }
  public newConversation(): void { this.service.newConversation(); this.question.set(""); }
  public toggleDock(): void {
    if (this.docked()) {
      this.left.set(Math.max(12, window.innerWidth - Math.min(390, window.innerWidth - 24) - 16));
      this.top.set(16);
      this.docked.set(false);
    } else {
      this.left.set(null);
      this.top.set(16);
      this.docked.set(true);
    }
  }
  public confidencePercent(response: AiAppAssistantResponse): number { return Math.round(response.confidence.score * 100); }
  public confidenceClass(response: AiAppAssistantResponse): string {
    return `ai-confidence-${response.confidence.level}`;
  }
  public confidenceNotice(response: AiAppAssistantResponse): string | undefined {
    if (response.confidence.level === "medium") return this.labels().mediumConfidence;
    if (response.confidence.level === "low") return this.labels().lowConfidence;
    if (response.confidence.level === "insufficient") return this.labels().insufficientConfidence;
    return undefined;
  }
  public progressLabel(phase: "preparing" | "thinking" | "writing" | "finalizing"): string {
    return phase === "preparing" ? this.labels().reading
      : phase === "thinking" ? this.labels().thinking
        : phase === "writing" ? this.labels().writing
          : this.labels().finalizing;
  }
  public visibleLimitations(response: AiAppAssistantResponse): string[] {
    return response.limitations.slice(0, 2);
  }
  public updateQuestion(event: Event): void { this.question.set((event.target as HTMLTextAreaElement).value); }
  public composerKeydown(event: KeyboardEvent): void { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void this.submit(); } }
  public async submit(event?: Event): Promise<void> {
    event?.preventDefault();
    if (this.service.conversationLimitReached()) return;
    const question = this.question().trim(); this.question.set("");
    try { await this.service.ask(question ? { question } : {}); } catch { /* visible state */ }
  }
  public async beginSelection(): Promise<void> {
    this.open.set(false);
    try {
      await this.service.selectElement();
      this.open.set(true);
    }
    catch (error) { if (normalizeError(error).name !== "AbortError") this.open.set(true); }
  }
  public cancelSelection(): void { this.service.cancelElementSelection(); this.open.set(true); }
  public clearSelection(): void { this.service.clearSelectedElement(); }
  public async retry(): Promise<void> { try { await this.service.retry(); } catch { /* visible state */ } }
  /** Relocates each sparkle between cycles; movement is hidden while transparent. */
  public randomizeStar(event: AnimationEvent): void {
    const star = event.currentTarget as HTMLElement;
    const between = (minimum: number, maximum: number): number =>
      Math.round(minimum + Math.random() * (maximum - minimum));
    for (let position = 0; position < 3; position += 1) {
      star.style.setProperty(`--ai-x${position}`, `${between(-16, 16)}px`);
      star.style.setProperty(`--ai-y${position}`, `${between(-15, 15)}px`);
      let deltaX = between(-3, 3);
      const deltaY = between(-3, 3);
      if (deltaX === 0 && deltaY === 0) deltaX = 2;
      star.style.setProperty(`--ai-dx${position}`, `${deltaX}px`);
      star.style.setProperty(`--ai-dy${position}`, `${deltaY}px`);
    }
  }
  public startDrag(event: PointerEvent): void {
    if (event.button !== 0 || window.innerWidth < 576) return;
    const panel = (event.currentTarget as HTMLElement).closest(".ai-panel") as HTMLElement | null;
    if (!panel) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    this.docked.set(false); this.left.set(rect.left); this.top.set(rect.top);
    const origin = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    const move = (next: PointerEvent) => {
      this.left.set(Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, origin.left + next.clientX - origin.x)));
      this.top.set(Math.max(0, Math.min(window.innerHeight - 56, origin.top + next.clientY - origin.y)));
    };
    const stop = () => this.dragCleanup?.();
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop, { once: true });
    this.dragCleanup = () => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", stop); this.dragCleanup = undefined;
    };
  }
}

function createAngularStreamTransport(http: HttpClient, config: AiAppAssistantAngularConfig): AiAppAssistantStreamTransport {
  return async function* (request, options) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const events$ = http.post(options.endpoint, request, {
      headers: toHttpHeaders(await config.headers?.()), observe: "events", reportProgress: true, responseType: "text"
    });
    let parsedLength = 0;
    let buffer = "";
    for await (const event of observableEvents<unknown>(events$, options.signal)) {
      const text = event instanceof HttpResponse
        ? String(event.body ?? "")
        : isDownloadProgress(event)
          ? event.partialText ?? ""
          : "";
      if (!text || text.length < parsedLength) continue;
      buffer += text.slice(parsedLength);
      parsedLength = text.length;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) yield JSON.parse(line);
    }
    if (buffer.trim()) yield JSON.parse(buffer);
  };
}

async function* observableEvents<T>(source: { subscribe: Function }, signal?: AbortSignal): AsyncGenerator<T> {
  const queue: T[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failure: unknown;
  const subscription = source.subscribe({
    next: (value: T) => { queue.push(value); wake?.(); },
    error: (error: unknown) => { failure = error; done = true; wake?.(); },
    complete: () => { done = true; wake?.(); }
  });
  const abort = () => { failure = abortReason(signal!); done = true; subscription.unsubscribe(); wake?.(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (!done || queue.length) {
      if (queue.length) { yield queue.shift()!; continue; }
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
    }
    if (failure) throw failure;
  } finally {
    signal?.removeEventListener("abort", abort); subscription.unsubscribe();
  }
}

function isDownloadProgress(event: unknown): event is HttpDownloadProgressEvent {
  return Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === HttpEventType.DownloadProgress);
}
function toHttpHeaders(input?: HeadersInit): HttpHeaders {
  let result = new HttpHeaders();
  if (!input) return result;
  new Headers(input).forEach((value, name) => { result = result.set(name, value); });
  return result;
}

/** Converts Angular HttpClient responses back to Fetch responses for generic clients. */
function createAngularFetch(http: HttpClient): typeof globalThis.fetch {
  return async (input, init): Promise<Response> => {
    const source = input instanceof Request ? input : undefined;
    const url = source?.url ?? String(input);
    const method = (init?.method ?? source?.method ?? "GET").toUpperCase();
    const headers = toHttpHeaders(init?.headers ?? source?.headers);
    let body = init?.body;
    if (body === undefined && source && method !== "GET" && method !== "HEAD") {
      body = await source.clone().text();
    }
    try {
      const result = await firstValueFrom(http.request(method, url, {
        headers,
        observe: "response",
        responseType: "text",
        ...(body !== undefined ? { body } : {})
      }));
      return new Response(result.body ?? "", {
        status: result.status,
        statusText: result.statusText,
        headers: toFetchHeaders(result.headers)
      });
    } catch (error) {
      if (!(error instanceof HttpErrorResponse)) throw error;
      const responseBody = typeof error.error === "string"
        ? error.error
        : JSON.stringify(error.error ?? { message: error.message });
      return new Response(responseBody, {
        status: error.status || 500,
        statusText: error.statusText,
        headers: toFetchHeaders(error.headers)
      });
    }
  };
}

function toFetchHeaders(input: HttpHeaders): Headers {
  const headers = new Headers();
  for (const name of input.keys()) {
    for (const value of input.getAll(name) ?? []) headers.append(name, value);
  }
  return headers;
}

function compactTheme(
  input: Partial<Record<keyof AiAppAssistantSettingsTheme, string | undefined>>
): Partial<AiAppAssistantSettingsTheme> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => Boolean(entry[1]))
  ) as Partial<AiAppAssistantSettingsTheme>;
}
function abortReason(signal: AbortSignal): unknown { return signal.reason ?? new DOMException("Aborted", "AbortError"); }

const ENGLISH_LABELS: AiAppAssistantUiLabels = {
  selectionInstruction: "Select an element on the page",
  cancel: "Cancel",
  newConversation: "New conversation",
  detach: "Detach",
  dock: "Dock",
  minimize: "Minimize",
  welcomeTitle: "How can I help?",
  welcomeBody: "Ask about this page or select a specific element.",
  reliability: "Confidence",
  retrying: "Retry",
  reading: "Reading the page…",
  thinking: "Thinking…",
  writing: "Writing the answer…",
  finalizing: "Checking the answer…",
  stop: "Stop generating",
  errorTitle: "The answer could not be generated.",
  retry: "Retry",
  placeholder: "Ask your question…",
  select: "Select element",
  elementSelected: "Element added to the conversation",
  mediumConfidence: "Based on the available information; verify before acting.",
  lowConfidence: "Likely answer based on limited information.",
  insufficientConfidence: "I do not have enough reliable information to answer.",
  conversationLimitReached: "Question limit reached. Start a new conversation to continue.",
  send: "Send"
};

const FRENCH_LABELS: AiAppAssistantUiLabels = {
  selectionInstruction: "Choisissez un élément dans la page",
  cancel: "Annuler",
  newConversation: "Nouvelle conversation",
  detach: "Détacher",
  dock: "Ancrer",
  minimize: "Réduire",
  welcomeTitle: "Comment puis-je vous aider ?",
  welcomeBody: "Interrogez cette page ou sélectionnez un élément précis.",
  reliability: "Fiabilité",
  retrying: "Nouvelle tentative",
  reading: "Lecture de la page…",
  thinking: "Réflexion…",
  writing: "Rédaction de la réponse…",
  finalizing: "Vérification de la réponse…",
  stop: "Arrêter la génération",
  errorTitle: "La réponse n’a pas pu être générée.",
  retry: "Réessayer",
  placeholder: "Posez votre question…",
  select: "Sélectionner un élément",
  elementSelected: "Élément ajouté à la conversation",
  mediumConfidence: "D’après les éléments disponibles ; à vérifier avant d’agir.",
  lowConfidence: "Je suppose ceci à partir d’informations limitées.",
  insufficientConfidence: "Je n’ai pas assez d’informations fiables pour répondre.",
  conversationLimitReached: "Limite de questions atteinte. Démarrez une nouvelle conversation pour continuer.",
  send: "Envoyer"
};
