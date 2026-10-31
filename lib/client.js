window.__ModuleLoader__.load({
  id: 'dsh-plugin-network-meter',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const { useState, useEffect, useCallback, useMemo, useRef } = React;
    const h = React.createElement;

    // Primitives from DSH, when the shell provides them.
    let primitives = {};
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch { /* the plugin renders without them */ }

    const STATS_ROUTE = '/api/network-meter/stats';
    const RESET_ROUTE = '/api/network-meter/reset';

    // ─────────────────────────────────────────────────────────────
    // Theme tokens (DSH system variables, with a readable fallback)
    // ─────────────────────────────────────────────────────────────
    const THEME = {
      bgPanel: 'var(--dsw-alias-bg-layer-1, #141c2a)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2, #1a2334)',
      bgLayer3: 'var(--dsw-alias-bg-layer-3, #222d42)',
      line: 'var(--dsw-alias-border-l2, #293449)',
      lineSubtle: 'var(--dsw-alias-border-l3, rgba(41, 52, 73, 0.6))',
      ink: 'var(--dsw-alias-label-primary, #edf3ff)',
      inkSecondary: 'var(--dsw-alias-label-secondary, #a1afc7)',
      inkMuted: 'var(--dsw-alias-label-tertiary, #76859f)',
      brand: 'var(--dsw-alias-brand-primary, #83aaff)',
      green: 'var(--dsw-alias-state-success-primary, #86e4ba)',
      yellow: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
      red: 'var(--dsw-alias-state-error-primary, #ffb1b1)',
      mono: 'ui-monospace, SFMono-Regular, Consolas, monospace'
    };

    // ─────────────────────────────────────────────────────────────
    // Formatting
    // ─────────────────────────────────────────────────────────────

    /**
     * Format a byte count for a readout.
     *
     * The unit is chosen so the number stays short; the exact byte count is
     * always available in the title attribute.
     */
    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return `${value} B`;
      const units = ['KB', 'MB', 'GB', 'TB'];
      let scaled = value / 1024;
      let unit = 0;
      while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024;
        unit += 1;
      }
      return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)} ${units[unit]}`;
    }

    function formatRate(bytes, ms) {
      if (!ms || ms <= 0) return '0 B/s';
      return `${formatBytes((bytes / ms) * 1000)}/s`;
    }

    function formatDuration(ms) {
      const seconds = Math.floor(ms / 1000);
      if (seconds < 60) return `${seconds} s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes} min`;
      return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
    }

    function formatClock(at) {
      try {
        return new Date(at).toLocaleTimeString();
      } catch {
        return '';
      }
    }

    const SCOPE_LABEL = {
      llm: 'LLM',
      web: 'Web',
      mcp: 'MCP',
      plugin: 'Плагины',
      other: 'Прочее'
    };

    const SCOPE_COLOR = {
      llm: THEME.brand,
      web: THEME.green,
      mcp: THEME.yellow,
      plugin: '#c4a1ff',
      other: THEME.inkMuted
    };

    // ─────────────────────────────────────────────────────────────
    // Store: polls the Host endpoint and keeps the last snapshot
    // ─────────────────────────────────────────────────────────────
    const store = {
      data: null,
      error: null,
      loading: false,
      listeners: new Set(),
      timer: null,

      subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
      },

      notify() {
        for (const fn of this.listeners) fn(this);
      },

      async load() {
        if (this.loading) return;
        this.loading = true;
        try {
          const res = await fetch(STATS_ROUTE, { headers: { Accept: 'application/json' } });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            this.error = data?.error || `HTTP ${res.status}`;
          } else {
            this.data = data;
            this.error = null;
          }
        } catch (err) {
          this.error = err instanceof Error ? err.message : String(err);
        } finally {
          this.loading = false;
          this.notify();
        }
      },

      async reset() {
        try {
          const res = await fetch(RESET_ROUTE, { method: 'POST' });
          const data = await res.json();
          if (data?.ok) this.data = data;
          else this.error = data?.error || 'Не удалось сбросить счётчики';
        } catch (err) {
          this.error = err instanceof Error ? err.message : String(err);
        }
        this.notify();
      },

      start(intervalMs) {
        this.stop();
        this.load();
        this.timer = setInterval(() => this.load(), intervalMs);
      },

      stop() {
        if (this.timer !== null) {
          clearInterval(this.timer);
          this.timer = null;
        }
      }
    };

    function useNetworkStats(intervalMs) {
      const [state, setState] = useState(store);
      useEffect(() => {
        const unsubscribe = store.subscribe(() => setState({ ...store, listeners: store.listeners }));
        store.start(intervalMs);
        return () => {
          unsubscribe();
          store.stop();
        };
      }, [intervalMs]);
      return state;
    }

    // ─────────────────────────────────────────────────────────────
    // Presentational pieces
    // ─────────────────────────────────────────────────────────────

    /** One big number with a label and a caption. */
    function StatTile({ label, value, caption, accent }) {
      return h(
        'div',
        {
          style: {
            flex: '1 1 0',
            minWidth: 0,
            padding: '10px 12px',
            borderRadius: '10px',
            background: THEME.bgLayer2,
            border: `1px solid ${THEME.lineSubtle}`
          }
        },
        h(
          'div',
          {
            style: {
              fontSize: '10px',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: THEME.inkMuted,
              marginBottom: '4px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }
          },
          label
        ),
        h(
          'div',
          {
            title: caption,
            style: {
              fontSize: '19px',
              fontWeight: 650,
              lineHeight: 1.15,
              color: accent || THEME.ink,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }
          },
          value
        ),
        caption
          ? h(
              'div',
              {
                title: caption,
                style: {
                  marginTop: '3px',
                  fontSize: '10.5px',
                  color: THEME.inkMuted,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }
              },
              caption
            )
          : null
      );
    }

    /** A labelled bar showing the split between sent and received bytes. */
    function SplitBar({ sent, received }) {
      const total = sent + received;
      const sentPct = total > 0 ? (sent / total) * 100 : 0;
      const receivedPct = total > 0 ? (received / total) * 100 : 0;
      return h(
        'div',
        {
          style: {
            display: 'flex',
            height: '8px',
            borderRadius: '999px',
            overflow: 'hidden',
            background: THEME.bgLayer3,
            border: `1px solid ${THEME.lineSubtle}`
          }
        },
        h('div', { title: `Отправлено ${formatBytes(sent)}`, style: { width: `${sentPct}%`, background: THEME.brand } }),
        h('div', { title: `Получено ${formatBytes(received)}`, style: { width: `${receivedPct}%`, background: THEME.green } })
      );
    }

    /** One row of the per-scope breakdown. */
    function ScopeRow({ row }) {
      const total = row.sentBytes + row.receivedBytes;
      return h(
        'div',
        { style: { padding: '7px 0', borderBottom: `1px solid ${THEME.lineSubtle}` } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '5px' } },
          h('span', {
            style: {
              width: '7px',
              height: '7px',
              borderRadius: '999px',
              background: SCOPE_COLOR[row.scope] || THEME.inkMuted,
              flex: '0 0 auto'
            }
          }),
          h(
            'span',
            { style: { fontSize: '12.5px', color: THEME.ink, fontWeight: 550 } },
            SCOPE_LABEL[row.scope] || row.scope
          ),
          h('span', {
            style: { marginLeft: 'auto', fontSize: '11px', color: THEME.inkMuted, fontVariantNumeric: 'tabular-nums' }
          }, `${row.requests} запр.`)
        ),
        h(SplitBar, { sent: row.sentBytes, received: row.receivedBytes }),
        h(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: '4px',
              fontSize: '10.5px',
              color: THEME.inkMuted,
              fontVariantNumeric: 'tabular-nums'
            }
          },
          h('span', { style: { color: THEME.brand } }, `↑ ${formatBytes(row.sentBytes)}`),
          h('span', { style: { color: THEME.green } }, `↓ ${formatBytes(row.receivedBytes)}`),
          h('span', null, formatBytes(total))
        )
      );
    }

    /** One row of the recent-requests log. */
    function RecentRow({ row }) {
      const failed = row.status === 0;
      const statusColor = failed ? THEME.red : row.status >= 400 ? THEME.yellow : THEME.green;
      return h(
        'div',
        {
          title: `${row.method} ${row.url}\n${row.error || `HTTP ${row.status}`}`,
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 0',
            borderBottom: `1px solid ${THEME.lineSubtle}`,
            fontSize: '11.5px'
          }
        },
        h('span', {
          style: {
            fontFamily: THEME.mono,
            fontSize: '10px',
            fontWeight: 700,
            color: statusColor,
            minWidth: '34px',
            flex: '0 0 auto'
          }
        }, failed ? 'ERR' : String(row.status)),
        h(
          'span',
          {
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: THEME.inkSecondary,
              fontFamily: THEME.mono
            }
          },
          row.host
        ),
        h('span', {
          style: { color: THEME.brand, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }
        }, `↑${formatBytes(row.sentBytes)}`),
        h('span', {
          style: { color: THEME.green, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }
        }, `↓${formatBytes(row.receivedBytes)}`),
        h('span', {
          style: { color: THEME.inkMuted, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto', minWidth: '52px', textAlign: 'right' }
        }, `${row.durationMs} ms`)
      );
    }

    // ─────────────────────────────────────────────────────────────
    // The sidebar tab body
    // ─────────────────────────────────────────────────────────────
    function NetworkMeterTab() {
      const state = useNetworkStats(1000);
      const data = state.data;

      const onReset = useCallback(() => { store.reset(); }, []);

      const header = h(
        'div',
        { style: { padding: '12px 14px 10px', borderBottom: `1px solid ${THEME.line}` } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('h2', {
            style: { margin: 0, fontSize: '14px', fontWeight: 650, color: THEME.ink, flex: '1 1 auto' }
          }, 'Сеть'),
          h(
            'button',
            {
              onClick: onReset,
              title: 'Обнулить счётчики',
              style: {
                fontSize: '11px',
                fontWeight: 600,
                padding: '4px 10px',
                borderRadius: '7px',
                border: `1px solid ${THEME.line}`,
                background: THEME.bgLayer2,
                color: THEME.inkSecondary,
                cursor: 'pointer'
              }
            },
            'Сброс'
          )
        )
      );

      if (state.error && !data) {
        return h(
          'div',
          { style: { padding: '16px 14px' } },
          header,
          h(
            'div',
            {
              style: {
                marginTop: '12px',
                padding: '10px 12px',
                borderRadius: '8px',
                background: 'rgba(255, 177, 177, 0.1)',
                border: '1px solid rgba(255, 177, 177, 0.3)',
                color: THEME.red,
                fontSize: '12px'
              }
            },
            `Не удалось получить данные: ${state.error}`
          )
        );
      }

      if (!data) {
        return h(
          'div',
          { style: { padding: '16px 14px' } },
          header,
          h('div', { style: { marginTop: '16px', color: THEME.inkMuted, fontSize: '12px' } }, 'Считаю трафик…')
        );
      }

      const uptime = data.uptimeMs || 1;

      return h(
        'div',
        { style: { padding: '12px 14px 20px', background: THEME.bgPanel, minHeight: '100%' } },
        header,

        !data.observing
          ? h(
              'div',
              {
                style: {
                  marginTop: '10px',
                  padding: '9px 11px',
                  borderRadius: '8px',
                  background: 'rgba(245, 158, 11, 0.1)',
                  border: '1px solid rgba(245, 158, 11, 0.3)',
                  color: THEME.yellow,
                  fontSize: '11.5px'
                }
              },
              `Наблюдение выключено${data.observationError ? `: ${data.observationError}` : ''}`
            )
          : null,

        // The two headline numbers.
        h(
          'div',
          { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
          h(StatTile, {
            label: 'Отправлено',
            value: formatBytes(data.sentBytes),
            caption: `${formatRate(data.sentBytes, uptime)} · ${data.requests} запросов`,
            accent: THEME.brand
          }),
          h(StatTile, {
            label: 'Получено',
            value: formatBytes(data.receivedBytes),
            caption: `${formatRate(data.receivedBytes, uptime)} · всего ${formatBytes(data.totalBytes)}`,
            accent: THEME.green
          })
        ),

        h(
          'div',
          { style: { marginTop: '10px' } },
          h(SplitBar, { sent: data.sentBytes, received: data.receivedBytes })
        ),

        h(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              marginTop: '8px',
              fontSize: '10.5px',
              color: THEME.inkMuted
            }
          },
          h('span', null, `За ${formatDuration(uptime)}`),
          h('span', null, data.errors > 0 ? `${data.errors} ошибок` : 'ошибок нет')
        ),

        // Per-scope breakdown.
        h(
          'h3',
          {
            style: {
              margin: '18px 0 2px',
              fontSize: '10px',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: THEME.inkMuted,
              fontWeight: 650
            }
          },
          'По направлениям'
        ),
        data.scopes.length === 0
          ? h('div', { style: { fontSize: '12px', color: THEME.inkMuted, padding: '8px 0' } }, 'Пока нет запросов.')
          : data.scopes.map((row) => h(ScopeRow, { key: row.scope, row })),

        // Per-host breakdown.
        h(
          'h3',
          {
            style: {
              margin: '18px 0 2px',
              fontSize: '10px',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: THEME.inkMuted,
              fontWeight: 650
            }
          },
          'По хостам'
        ),
        data.hosts.length === 0
          ? h('div', { style: { fontSize: '12px', color: THEME.inkMuted, padding: '8px 0' } }, 'Пока нет запросов.')
          : data.hosts.map((row) =>
              h(
                'div',
                {
                  key: row.host,
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '5px 0',
                    borderBottom: `1px solid ${THEME.lineSubtle}`,
                    fontSize: '11.5px'
                  }
                },
                h('span', {
                  style: {
                    width: '6px',
                    height: '6px',
                    borderRadius: '999px',
                    background: SCOPE_COLOR[row.scope] || THEME.inkMuted,
                    flex: '0 0 auto'
                  }
                }),
                h('span', {
                  style: {
                    flex: '1 1 auto',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: THEME.inkSecondary,
                    fontFamily: THEME.mono
                  }
                }, row.host),
                h('span', {
                  style: { color: THEME.ink, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }
                }, formatBytes(row.sentBytes + row.receivedBytes))
              )
            ),

        // The recent-request log.
        h(
          'h3',
          {
            style: {
              margin: '18px 0 2px',
              fontSize: '10px',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: THEME.inkMuted,
              fontWeight: 650
            }
          },
          'Последние запросы'
        ),
        data.recent.length === 0
          ? h('div', { style: { fontSize: '12px', color: THEME.inkMuted, padding: '8px 0' } }, 'Пока нет запросов.')
          : data.recent.map((row, index) => h(RecentRow, { key: `${row.at}-${index}`, row })),

        h(
          'p',
          {
            style: {
              marginTop: '16px',
              fontSize: '10.5px',
              lineHeight: 1.5,
              color: THEME.inkMuted
            }
          },
          'Учитываются исходящие HTTP-запросы Host: LLM, веб-поиск, MCP и рынок плагинов. ' +
          'Запросы, сделанные браузером напрямую, и телеметрия не входят в счёт.'
        )
      );
    }

    /** The tab chip title in the sidebar strip. */
    function NetworkMeterTabTitle() {
      const state = useNetworkStats(1000);
      const data = state.data;
      const label = data ? `${formatBytes(data.sentBytes)} ↑ ${formatBytes(data.receivedBytes)} ↓` : 'Сеть';
      return h(
        'span',
        {
          style: {
            fontFamily: THEME.mono,
            fontSize: '10.5px',
            color: THEME.inkSecondary,
            fontVariantNumeric: 'tabular-nums'
          }
        },
        label
      );
    }

    /** The compact indicator in the conversation header. */
    function NetworkMeterHeaderIndicator() {
      const state = useNetworkStats(2000);
      const data = state.data;
      if (!data) return null;
      return h(
        'span',
        {
          title: `Сеть: отправлено ${data.sentBytes} B, получено ${data.receivedBytes} B за ${data.requests} запросов`,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontFamily: THEME.mono,
            fontSize: '10.5px',
            color: THEME.inkSecondary,
            fontVariantNumeric: 'tabular-nums',
            padding: '2px 7px',
            borderRadius: '999px',
            border: `1px solid ${THEME.lineSubtle}`,
            background: THEME.bgLayer2
          }
        },
        h('span', { style: { color: THEME.brand } }, `↑${formatBytes(data.sentBytes)}`),
        h('span', { style: { color: THEME.green } }, `↓${formatBytes(data.receivedBytes)}`)
      );
    }

    // ─────────────────────────────────────────────────────────────
    // Cordis client plugin definition
    // ─────────────────────────────────────────────────────────────
    const TAB_ID = 'dsh-plugin-network-meter';

    const inject = ['slots', 'sidebarRightTabs', 'sidebarRight'];

    function apply(ctx) {
      if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
        try {
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_ID,
            title: () => 'Сеть',
            guide: [
              {
                id: TAB_ID,
                order: 20,
                title: () => 'Сеть',
                description: () => 'Сколько трафика DSH отправляет и получает'
              }
            ]
          });
        } catch (err) {
          if (!String(err?.message || err).includes('already registered')) {
            console.warn('network-meter: sidebarRightTabs.register', err);
          }
        }
      }

      if (ctx.slots) {
        try {
          ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: TAB_ID
          }, NetworkMeterTab));
        } catch (err) {
          console.warn('network-meter: slots.inject sidebar.right.pane.tab', err);
        }

        try {
          ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: TAB_ID
          }, NetworkMeterTabTitle));
        } catch (err) {
          console.warn('network-meter: slots.inject sidebar.right.pane.tab.title', err);
        }

        try {
          ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'network-meter-indicator',
            order: -20,
            label: () => 'Сеть'
          }, NetworkMeterHeaderIndicator));
        } catch (err) {
          console.warn('network-meter: slots.inject conversation.session.header.utilities', err);
        }
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
