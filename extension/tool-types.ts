// The browser tools' arguments and results, as background.ts handles them.
//
// Arguments arrive over native messaging from the host, which validates the
// public tools against the zod schemas in host/tool-definitions.ts before
// forwarding them. The hidden Jev tools (jev_snapshot, jev_settle, jev_act)
// are called only by host/jev. Either way the host is the trust boundary, and
// background.ts's dispatcher is where these shapes are asserted.

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

/** An MCP CallToolResult, as the extension produces one. */
export interface ToolResult {
  content: Array<TextBlock | ImageBlock>;
}

/** A point in screenshot pixels, [x, y]. */
export type Coordinate = number[];

// Optional fields also admit `undefined`: jev_act forwards its own optional
// arguments to the other handlers as they are.
export interface ToolArgsMap {
  tabs_context_mcp: { createIfEmpty?: boolean | undefined };
  tabs_create_mcp: Record<string, unknown>;
  tabs_close_mcp: { tabId?: number | string | undefined; tabIds?: Array<number | string> | undefined };
  navigate: { url: string; tabId: number };
  computer: {
    action: string;
    tabId: number;
    coordinate?: Coordinate | undefined;
    start_coordinate?: Coordinate | undefined;
    ref?: string | undefined;
    modifiers?: string | undefined;
    text?: string | undefined;
    repeat?: number | undefined;
    scroll_direction?: "up" | "down" | "left" | "right" | undefined;
    scroll_amount?: number | undefined;
    duration?: number | undefined;
    region?: number[] | undefined;
    save_to_disk?: boolean | undefined;
  };
  read_page: {
    tabId: number;
    filter?: string | undefined;
    depth?: number | undefined;
    max_chars?: number | undefined;
    ref_id?: string | undefined;
  };
  jev_snapshot: {
    tabId: number;
    depth?: number | undefined;
    max_rows?: number | undefined;
    text_chars?: number | undefined;
    full_text?: boolean | undefined;
  };
  jev_settle: {
    tabId: number;
    expect?: string | undefined;
    fromUrl?: string | undefined;
    ref?: string | undefined;
    timeoutMs?: number | undefined;
  };
  jev_act: {
    tabId: number;
    operation: string;
    ref?: string | undefined;
    value?: string | undefined;
    formField?: boolean | undefined;
    expect?: { role?: string; name?: string } | undefined;
  };
  get_page_text: { tabId: number };
  find: { query: string; tabId: number };
  form_input: { ref: string | undefined; value: unknown; tabId: number };
  javascript_tool: { text: string; tabId: number; timeout_ms?: number | undefined; action?: string | undefined };
  debug_timings: { limit?: number | undefined; clear?: boolean | undefined };
  read_console_messages: {
    tabId: number;
    pattern?: string | undefined;
    limit?: number | undefined;
    onlyErrors?: boolean | undefined;
    clear?: boolean | undefined;
  };
  read_network_requests: {
    tabId: number;
    urlPattern?: string | undefined;
    limit?: number | undefined;
    clear?: boolean | undefined;
  };
  resize_window: { width: number; height: number; tabId: number };
  upload_image: { imageId: string; tabId: number; ref?: string | undefined; filename?: string | undefined };
  retranscribe_recording: { recording_id?: string | undefined };
  file_upload: { tabId: number; paths?: unknown; ref?: unknown };
  gif_creator: Record<string, unknown>;
  shortcuts_list: Record<string, unknown>;
  shortcuts_execute: Record<string, unknown>;
  switch_browser: Record<string, unknown>;
  update_plan: { domains: string[]; approach: string[] };
  debug: {
    limit?: number | undefined;
    kind?: string | undefined;
    filter?: string | undefined;
    tabId?: number | undefined;
    since_ms?: number | undefined;
    clear?: boolean | undefined;
  };
  get_config: { tabId?: number | undefined };
  set_config: { key?: unknown; value?: unknown; tabId?: number | undefined };
  set_tab_focus: { tabId: number; focus_window?: boolean | undefined };
}

export type ToolName = keyof ToolArgsMap;

export type ToolHandlers = { [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolResult> };

/** Is `name` a tool the extension handles? */
export function isToolName(name: string, handlers: ToolHandlers): name is ToolName {
  return Object.hasOwn(handlers, name);
}
