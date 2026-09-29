import { randomBytes } from 'node:crypto';
import { Halt, norm } from './language.mjs';
const ATTR = 'data-laya-live-ref';
export async function observe(page) {
    const nonce = randomBytes(5).toString('hex'),
        controls = [];
    const frames = page.frames();
    for (let fi = 0; fi < frames.length; fi++) {
        const items = await frames[fi]
            .evaluate(
                ({ nonce, fi, attr }) => {
                    const visible = (e) => {
                        const s = getComputedStyle(e),
                            r = e.getBoundingClientRect();
                        return (
                            s.display !== 'none' &&
                            s.visibility !== 'hidden' &&
                            r.width > 0 &&
                            r.height > 0 &&
                            !e.closest('[inert],[aria-hidden="true"]')
                        );
                    };
                    const text = (e) =>
                        (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
                    const roots = [document];
                    for (let i = 0; i < roots.length; i++)
                        for (const e of roots[i].querySelectorAll('*'))
                            if (e.shadowRoot) roots.push(e.shadowRoot);
                    const selector =
                        'button,a[href],input:not([type="hidden"]),textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],[tabindex],[contenteditable="true"],summary';
                    let elements = roots
                        .flatMap((root) => [...root.querySelectorAll(selector)])
                        .filter(visible);
                    // Some enterprise navigation bars have clickable divs with no ARIA roles.
                    const pointer = roots
                        .flatMap((root) => [...root.querySelectorAll('div,span,li')])
                        .filter(
                            (e) =>
                                visible(e) &&
                                getComputedStyle(e).cursor === 'pointer' &&
                                text(e).length > 0 &&
                                text(e).length < 45 &&
                                !e.closest(selector) &&
                                !e.querySelector(selector) &&
                                ![...e.children].some(
                                    (c) => getComputedStyle(c).cursor === 'pointer',
                                ),
                        );
                    elements = [...new Set([...elements, ...pointer])];
                    // A menuitem wrapping its same-named link is one action, not two Laya
                    // candidates. Keep the inner native control and retain distinct siblings.
                    elements = elements.filter(
                        (e) =>
                            !(
                                e.getAttribute('role') === 'menuitem' &&
                                [...e.querySelectorAll('a[href],button')].some(
                                    (child) => visible(child) && text(child) === text(e),
                                )
                            ),
                    );
                    const modals = roots
                        .flatMap((root) => [
                            ...root.querySelectorAll(
                                'dialog[open],[role="dialog"],[role="alertdialog"],[data-slot="dialog-content"],[data-slot="alert-dialog-content"],.ant-drawer-open .ant-drawer-content,.el-dialog',
                            ),
                        ])
                        .filter(visible);
                    const modal = modals.at(-1);
                    // Options can be portaled outside their owning dialog.
                    if (modal)
                        elements = elements.filter(
                            (e) =>
                                modal.contains(e) ||
                                e.closest(
                                    '[role="listbox"],.ant-select-dropdown,.el-select-dropdown',
                                ),
                        );
                    // Filter and query bars are usually plain divs with no form or role. Any
                    // container holding a form control is a region worth naming — one search box
                    // counts as much as six — which is what tells same-named controls in a menu, a
                    // row or a dialog apart. querySelector stops at the first hit, so this is cheap.
                    const groupsInputs = (n) =>
                        !!n.querySelector?.('input,select,textarea,[role="combobox"]');
                    return elements
                        .slice(0, 800)
                        .map((e, i) => {
                            const tag = e.tagName.toLowerCase(),
                                type = e.getAttribute('type') || '';
                            let role =
                                e.getAttribute('role') ||
                                {
                                    button: 'button',
                                    a: 'link',
                                    textarea: 'textbox',
                                    select: 'combobox',
                                    summary: 'button',
                                }[tag] ||
                                (tag === 'input'
                                    ? {
                                          checkbox: 'checkbox',
                                          radio: 'radio',
                                          number: 'spinbutton',
                                          password: 'password',
                                      }[type] || 'textbox'
                                    : 'button');
                            const labelled = (e.getAttribute('aria-labelledby') || '')
                                .split(/\s+/)
                                .map((id) => text(document.getElementById(id)))
                                .join(' ')
                                .trim();
                            const labels = e.labels ? [...e.labels].map(text).join(' ') : '';
                            const parentLabel = text(
                                e.closest('.ant-form-item,.el-form-item')?.querySelector('label'),
                            );
                            let sibLabel = '';
                            if (['input', 'textarea', 'select'].includes(tag)) {
                                let n = e.previousElementSibling;
                                while (n) {
                                    if (/^label$/i.test(n.tagName)) {
                                        sibLabel = text(n);
                                        break;
                                    }
                                    n = n.previousElementSibling;
                                }
                                if (!sibLabel) {
                                    n = e.parentElement?.previousElementSibling || null;
                                    while (n) {
                                        if (/^label$/i.test(n.tagName)) {
                                            sibLabel = text(n);
                                            break;
                                        }
                                        n = n.previousElementSibling;
                                    }
                                }
                            }
                            const selectBox = e.closest(
                                '.ant-select,.tntd-rc-select,.el-select,[role="combobox"]',
                            );
                            const selectHint =
                                text(
                                    selectBox?.querySelector(
                                        '.ant-select-selection-item,.ant-select-selection-overflow-item,.ant-select-selection__placeholder,.ant-select-selection-placeholder,.tntd-rc-select-selection-placeholder,.el-input__inner',
                                    ),
                                ) || text(selectBox);
                            const ownText = ['input', 'textarea'].includes(tag) ? '' : text(e);
                            const tooltip = e.getAttribute('data-laya-tooltip-label') || '';
                            const tooltipAction = tooltip.match(/不支持(.+?)(?:操作)?$/)?.[1];
                            // Value semantics often live on an ancestor (date cells: td[title]).
                            const ancestorTitle = e.closest('[title]')?.getAttribute('title') || '';
                            // Nearest short text block acts as the visual label; some layouts put it
                            // after the control (antd-pro renders a select's value in a sibling span).
                            const neighborText = (() => {
                                let scope = e;
                                for (let up = 0; up < 3 && scope; up++) {
                                    let n = scope.previousElementSibling;
                                    while (n) {
                                        const t = text(n);
                                        if (t && t.length < 50 && !n.querySelector?.(selector)) return t;
                                        n = n.previousElementSibling;
                                    }
                                    n = scope.nextElementSibling;
                                    while (n) {
                                        const t = text(n);
                                        if (t && t.length < 50 && !n.querySelector?.(selector)) return t;
                                        n = n.nextElementSibling;
                                    }
                                    scope = scope.parentElement;
                                }
                                return '';
                            })();
                            // A colon-terminated short text block directly before the control is its
                            // visual field label. Keep it as an alias: intent wording can match it
                            // without displacing the display value or placeholder that name carries.
                            // Stop at the first sibling that is itself a control, so a label never
                            // leaks past the field it belongs to.
                            const colonLabel = (() => {
                                const isControl = (x) =>
                                    !!x.matches?.(selector) || !!x.querySelector?.(selector);
                                let scope = e;
                                for (let up = 0; up < 3 && scope; up++) {
                                    let n = scope.previousElementSibling;
                                    while (n) {
                                        if (isControl(n)) return '';
                                        const t = text(n);
                                        if (/^[^：:]{1,11}[：:]$/.test(t)) return t;
                                        n = n.previousElementSibling;
                                    }
                                    scope = scope.parentElement;
                                }
                                return '';
                            })();
                            // Inside a table, the column header names the control.
                            const cell = e.closest('td,th');
                            const columnHeader = cell
                                ? text(cell.closest('table')?.querySelectorAll('thead th')[cell.cellIndex])
                                : '';
                            // Never nameless: a structural name keeps the control observable and
                            // replayable instead of silently dropping it from the candidate pool.
                            const container =
                                e.closest('form,dialog,[role="dialog"],.ant-drawer-content,td,li') ||
                                document.body;
                            const structural =
                                '未命名' +
                                role +
                                '#' +
                                (container
                                    ? [...container.querySelectorAll(selector)].indexOf(e) + 1
                                    : 0);
                            const nameParts = [
                                ['tooltip', tooltipAction || tooltip],
                                ['aria-label', e.getAttribute('aria-label')],
                                ['aria-labelledby', labelled],
                                ['label', labels],
                                ['form-item', parentLabel],
                                ['sibling-label', sibLabel],
                                ['placeholder', e.getAttribute('placeholder')],
                                ['title', e.getAttribute('title')],
                                ['text', ownText],
                                ['select-placeholder', selectHint],
                                ['ancestor-title', ancestorTitle],
                                ['neighbor-text', neighborText],
                                ['column-header', columnHeader],
                                ['name-attr', e.getAttribute('name')],
                                ['structural', structural],
                            ];
                            const hit = nameParts.find(([, v]) => v) || ['structural', structural];
                            const nameSource = hit[0];
                            const name = String(hit[1]).replace(/^\*\s*/, '').slice(0, 130);
                            const row = e.closest('tr,[role="row"]'),
                                group = e.closest('fieldset,[role="group"],form');
                            const rowKey = row?.getAttribute('data-row-key') || '';
                            // Fixed operation columns have rows containing only icons. Join their live
                            // data-row-key to the main table, rather than mistaking all icons for one row.
                            const peers = rowKey
                                ? [...document.querySelectorAll('tr[data-row-key]')].filter(
                                      (r) => r.getAttribute('data-row-key') === rowKey,
                                  )
                                : [];
                            const rowText = [
                                ...new Set([text(row), ...peers.map(text)].filter(Boolean)),
                            ]
                                .sort((a, b) => b.length - a.length)
                                .join(' | ');
                            const context = row
                                ? rowText.slice(0, 500)
                                : text(group?.querySelector('legend,h1,h2,h3')).slice(0, 70);
                            // Two controls can share a visible name — a menu link 搜索 and the
                            // filter bar's button 搜索 — and the classifier can only tell them
                            // apart by the type and region words appended to the label. Both come
                            // from generic UI vocabulary (ARIA roles, landmarks), never from site
                            // vocabulary.
                            const typeWord =
                                {
                                    link: '链接',
                                    button: '按钮',
                                    textbox: '输入框',
                                    searchbox: '搜索框',
                                    combobox: '下拉框',
                                    checkbox: '复选框',
                                    radio: '单选',
                                    switch: '开关',
                                    tab: '标签页',
                                    menuitem: '菜单项',
                                    menu: '菜单',
                                    option: '选项',
                                    spinbutton: '数字框',
                                    password: '密码框',
                                    treeitem: '树节点',
                                }[role] || role;
                            // Landmarks are tried most-specific first, so a row inside a dialog is
                            // described as 数据行 and a menu inside a header as 菜单栏; only when no
                            // landmark applies does the vaguer "groups form controls" rule speak.
                            const area = (() => {
                                const climb = (test) => {
                                    let depth = 0;
                                    for (let n = e; n; n = n.parentElement, depth++)
                                        if (test(n, depth)) return true;
                                    return false;
                                };
                                const landmarks = [
                                    ['tr,[role="row"]', '数据行'],
                                    ['[role="dialog"],dialog,.ant-modal-content,.el-dialog', '弹窗'],
                                    ['.ant-drawer-content,.el-drawer', '抽屉'],
                                    ['[role="menu"],.ant-menu,nav,[role="navigation"]', '菜单栏'],
                                    [
                                        '[role="listbox"],.ant-select-dropdown,.el-select-dropdown',
                                        '下拉列表',
                                    ],
                                    ['table,[role="table"],.ant-table', '表格'],
                                    ['[role="tabpanel"],.ant-tabs-tabpane', '标签页'],
                                    ['header,[role="banner"]', '页头'],
                                    ['aside,[role="complementary"]', '侧栏'],
                                ];
                                for (const [sel, word] of landmarks)
                                    if (climb((n) => n.matches?.(sel))) return word;
                                // A div-built query bar and a real <form> are the same region to
                                // whoever writes the case, so one label carries the three words
                                // they use for it. Measured against a same-named menu link, the
                                // compound matched every phrasing (筛选区 0.999 / 表单 0.784 /
                                // 查询条件 0.990 / 筛选条件 0.993) while any single word lost on the
                                // phrasings it did not contain (0.766–0.910 for the wrong one).
                                if (
                                    climb(
                                        (n, d) =>
                                            n.matches?.('form,[role="search"],.ant-form') ||
                                            (d && d <= 5 && groupsInputs(n)),
                                    )
                                )
                                    return '筛选区/查询条件/表单';
                                return climb((n) => n.matches?.('main,[role="main"]'))
                                    ? '主区域'
                                    : '';
                            })();
                            const ref = nonce + '-' + fi + '-' + i;
                            e.setAttribute(attr, ref);
                            return {
                                ref,
                                frame: fi,
                                tag,
                                role,
                                name,
                                nameSource,
                                alias: colonLabel,
                                typeWord,
                                area,
                                tooltip,
                                rowKey,
                                placeholder: e.getAttribute('placeholder') || '',
                                context,
                                inPanel: !!e.closest('[role="tabpanel"]'),
                                disabled:
                                    e.matches(':disabled') ||
                                    e.hasAttribute('disabled') ||
                                    e.getAttribute('aria-disabled') === 'true' ||
                                    !!e.closest(
                                        '.ant-select-disabled,[aria-disabled="true"],.disabled,.is-disabled',
                                    ) ||
                                    (role === 'menuitem' &&
                                        !!e.querySelector(
                                            'a[disabled],button[disabled],a.disabled,button.disabled',
                                        )),
                                readonly: e.readOnly === true,
                                selected:
                                    e.getAttribute('aria-selected') === 'true' ||
                                    e.classList.contains('ant-menu-item-selected') ||
                                    !!e.closest('.ant-menu-item-selected'),
                                checked:
                                    e.checked === true || e.getAttribute('aria-checked') === 'true',
                                href: e.getAttribute('href') || '',
                                value:
                                    type === 'password'
                                        ? '[REDACTED]'
                                        : ('value' in e ? String(e.value) : '').slice(0, 160),
                            };
                        })
                        .filter((x) => x.name || x.role === 'password');
                },
                { nonce, fi, attr: ATTR },
            )
            .catch(() => []);
        controls.push(...items);
    }
    return { url: page.url(), controls, frames };
}
export function score(target, c) {
    const t = norm(target),
        n = norm(c.name),
        p = norm(c.placeholder),
        al = norm(c.alias),
        context = norm(c.context);
    if (!t) return 0;
    // Chinese admin UIs decorate the human label (请输入X / X可多选); the decorated form is
    // still the same field, so core equality counts as an exact match and can short-circuit.
    // Site vocabulary (synonyms, business labels) does NOT belong here: it ships per run via
    // --labels, keeping this layer mechanical and unbounded-grow-free.
    const core = (s) => s.replace(/^(?:请输入|请选择|输入|选择)/, '').replace(/(?:可多选|多选)$/, '');
    const chain = (name, intent) =>
        name === intent ? 120 : name.includes(intent) ? 85 : intent.includes(name) && name.length > 1 ? 65 : 0;
    const tc = core(t);
    let s = Math.max(chain(n, t), chain(core(n), tc));
    if (al) s = Math.max(s, chain(al, t), chain(core(al), tc));
    if (p && (p.includes(t) || core(p).includes(tc))) s = Math.max(s, 75);
    if (context.includes(t)) s += 30;
    const a = new Set([...t]);
    s += ([...new Set([...n])].filter((x) => a.has(x)).length / Math.max(1, a.size)) * 12;
    return s;
}
// antd inserts a space between the two characters of a short CJK button label (搜 索). It is
// invisible on screen but breaks literal matching against the step text, so collapse exactly that
// shape and leave every other label — including multi-word names — untouched.
export const displayable = (s) =>
    String(s).replace(/^([\u4e00-\u9fff])\s+([\u4e00-\u9fff])$/, '$1$2');
export const controlHint = (c) => [c.typeWord, c.area].filter(Boolean).join('·');
export const namesClash = (list) => {
    const names = list.map((c) => norm(displayable(c.name)));
    return names.some((n, i) => names.indexOf(n) !== i);
};
// Option labels the classifier chooses from. The type·region suffix is added only when it tells
// the candidates apart; when every candidate would carry the same suffix it just dilutes the
// name, which measurably costs confidence.
export function optionKeys(list) {
    const display = list.map((c) => displayable(c.name));
    const hints = list.map(controlHint);
    const showHints = new Set(hints.filter(Boolean)).size > 1;
    const base = display.map(
        (n, i) => n.slice(0, 36) + (showHints && hints[i] ? '（' + hints[i] + '）' : ''),
    );
    const used = new Map();
    return list.map((control, i) => {
        let key = base[i];
        if (base.indexOf(key) !== base.lastIndexOf(key))
            key += ' [' + ((control.context || '').slice(0, 16) || control.role) + '] #' + i;
        const seen = used.get(key) || 0;
        used.set(key, seen + 1);
        return { key: seen ? key + ' #' + i : key, display: display[i], control };
    });
}
export async function discoverRowLabels(page, rowKey) {
    let snap = await observe(page);
    const icons = snap.controls.filter((c) => c.rowKey === rowKey && /^图标[:：]/.test(c.name));
    // Only hover real DOM controls, never click an unknown icon to discover it.
    for (const icon of icons.slice(0, 12)) {
        const loc = snap.frames[icon.frame].locator(`[${ATTR}="${icon.ref}"]`);
        try {
            await page.mouse.move(0, 0);
            const tips = snap.frames[icon.frame].locator(
                '[role="tooltip"]:visible,.ant-tooltip:visible,.el-tooltip__popper:visible',
            );
            await tips
                .first()
                .waitFor({ state: 'hidden', timeout: 900 })
                .catch(() => {});
            await loc.hover({ timeout: 1500 });
            await tips
                .first()
                .waitFor({ state: 'visible', timeout: 650 })
                .catch(() => {});
            await page.waitForTimeout(350);
            const labels = [
                ...new Set((await tips.allTextContents()).map((s) => s.trim()).filter(Boolean)),
            ];
            if (labels.length === 1 && labels[0].length < 100)
                await loc.evaluate(
                    (e, label) => e.setAttribute('data-laya-tooltip-label', label),
                    labels[0],
                );
        } catch {}
    }
    await page.mouse.move(0, 0);
    return observe(page);
}
export async function target(
    page,
    laya,
    intent,
    {
        kind = 'click',
        value,
        meta = {},
        rowKey,
        stepText = '',
        allowDisabled = false,
        minProbability = 0.68,
        minMargin = 0.18,
        observeRetries = 8,
        observeInterval = 250,
    } = {},
) {
    let snap = await observe(page);
    // Bounded observation retries accommodate late asynchronous rendering; no action is retried.
    for (
        let i = 0;
        i < observeRetries && !snap.controls.some((c) => score(intent, c) >= 65);
        i++
    ) {
        await page.waitForTimeout(observeInterval);
        snap = await observe(page);
    }
    let candidates = snap.controls.filter(
        (c) => c.role !== 'password' && (allowDisabled || !c.disabled),
    );
    if (rowKey) candidates = candidates.filter((c) => c.rowKey === rowKey);
    if (['fill', 'clear', 'value', 'empty'].includes(kind))
        candidates = candidates.filter(
            (c) => ['textbox', 'spinbutton'].includes(c.role) && !c.readonly,
        );
    if (kind === 'select')
        candidates = candidates.filter((c) => c.role === 'combobox' || c.tag === 'select');
    if (['check', 'uncheck', 'checked'].includes(kind))
        candidates = candidates.filter((c) => ['checkbox', 'radio', 'switch'].includes(c.role));
    if (kind === 'option')
        candidates = candidates.filter(
            (c) =>
                c.role === 'option' ||
                c.role === 'menuitem' ||
                c.role === 'button' ||
                c.role === 'menuitemcheckbox' ||
                c.role === 'treeitem',
        );
    // A step acts on the page it is written for; navigation has its own verb (进入/打开). So on
    // an equal score, the control that stays on the current route is listed first — and with no
    // discriminator in the question the classifier follows list order (measured: 0.64–0.91 for
    // whichever option came first).
    const sameRoute = (href) => {
        try {
            const a = new URL(href, snap.url),
                b = new URL(snap.url);
            return a.origin + a.pathname + a.search + a.hash === b.origin + b.pathname + b.search + b.hash;
        } catch {
            return true;
        }
    };
    const leavesRoute = (c) =>
        c.href && !/^(?:javascript:|#$)/i.test(c.href) && !sameRoute(c.href) ? 1 : 0;
    const ranked = candidates
        .map((c) => ({ ...c, rank: score(intent, c) }))
        .sort((a, b) => b.rank - a.rank || leavesRoute(a) - leavesRoute(b));
    const unique = [];
    for (const c of ranked) {
        // A nested accessible input within its combobox is not a second target.
        if (
            unique.some(
                (x) =>
                    x.name === c.name &&
                    x.context === c.context &&
                    x.role === c.role &&
                    x.frame === c.frame &&
                    x.href === c.href,
            )
        )
            continue;
        unique.push(c);
    }
    if (!unique.length)
        throw new Halt('页面控件不足', `当前页面没有可用于${kind}的控件：${intent}`);
    const scored = unique.filter((c) => c.rank >= 65);
    const shortlist = (scored.length ? scored : unique).slice(0, 5);
    if (
        ranked.length >= 2 &&
        ranked[0].rank >= 100 &&
        ranked[1].rank === ranked[0].rank &&
        ranked[0].name === ranked[1].name &&
        ranked[0].context !== ranked[1].context &&
        !norm(intent).includes(norm(ranked[0].context))
    )
        throw new Halt('目标不唯一', `多个区域存在“${intent}”，请在步骤写明记录名称或区域。`);
    // An exact, unique live match leaves nothing for the classifier to decide; the workflow
    // path already short-circuits single candidates, and the gate's calibration floor would
    // otherwise veto unambiguous steps (observed: p=0.507, margin 0.014 on an identical
    // string). Same name+context always scores identically, so a lone >=100 shortlist entry
    // also guarantees there is no duplicate control to disambiguate.
    const certain = shortlist.length === 1 && shortlist[0].rank >= 100 ? shortlist[0] : null;
    if (certain) {
        const certainLocator = snap.frames[certain.frame].locator(
            `[${ATTR}="${certain.ref}"]`,
        );
        if ((await certainLocator.count()) === 1 && (await certainLocator.isVisible())) {
            console.log('  精确唯一匹配，跳过模型：' + certain.name);
            return {
                locator: certainLocator,
                control: certain,
                decision: {
                    choice: certain.name,
                    deterministic: true,
                    probabilities: { [certain.name]: 1 },
                    margin: 1,
                },
            };
        }
    }
    const en = /[a-z]/i.test(intent) && !/[\u4e00-\u9fff]/.test(intent);
    const prefix = en
        ? {
              fill: 'Fill ',
              clear: 'Clear ',
              select: 'Select ',
              option: 'Choose ',
              check: 'Check ',
              uncheck: 'Uncheck ',
              hover: 'Hover over ',
              click: 'Click ',
          }[kind] || 'Find '
        : {
              fill: '填写',
              clear: '清空',
              select: '选择',
              option: '选择',
              check: '勾选',
              uncheck: '取消勾选',
              hover: '悬停在',
              click: '点击',
          }[kind] || '查看';
    // Two controls can carry the same visible name — a menu link 搜索 and a form button 搜索.
    // The classifier only aligns literal tokens, so resolving that clash takes both sides: the
    // type·region label on the options and the step's own qualifier in the question. Measured
    // 0.97–0.99 with both, 0.48–0.71 with labels alone (under the gate), and a label that is
    // identical across every option is pure noise (a dropdown choice fell 0.87 → 0.39), so labels
    // are rendered only when they actually differ.
    const keyed = optionKeys(shortlist);
    const criteria = Object.fromEntries(
        keyed.map(({ key, display, control: c }) => [
            key,
            prefix +
                (c.alias
                    ? c.alias.replace(/[：:]$/, '') + '（' + display.slice(0, 24) + '）'
                    : display.slice(0, 38)),
        ]),
    );
    const stopKey = en ? 'Stop' : '停止';
    criteria[stopKey] = en ? 'Do not perform any action' : '不执行';
    // The extracted target drops the qualifier ("表单里的…按钮") that the labels need to match
    // against, so on a name clash the question becomes the step as written.
    const question = namesClash(shortlist) && stepText ? stepText.slice(0, 80) : prefix + intent;
    const decision = await laya.choose(question, criteria, {
        ...meta,
        phase: 'target',
        url: snap.url,
        candidate_count: snap.controls.length,
        candidates: shortlist.map(({ ref, ...c }) => c),
    });
    if (decision.choice === stopKey)
        throw new Halt('Laya无法判断', `Laya未找到匹配控件：${intent}`);
    const c = keyed.find((x) => x.key === decision.choice)?.control;
    if (!c) throw new Halt('模型结果无效', '模型返回无法映射到当前DOM的目标');
    if (
        (decision.probabilities?.[decision.choice] || 0) < minProbability ||
        decision.margin < minMargin
    )
        throw new Halt('Laya选择不确定', `目标“${intent}”的候选评分或差距不足，停止本步。`);
    const locator = snap.frames[c.frame].locator(`[${ATTR}="${c.ref}"]`);
    if ((await locator.count()) !== 1 || !(await locator.isVisible()))
        throw new Halt('DOM已变化', '决定完成后DOM已变化，当前步骤停止，避免误点。');
    // Distinct identical controls require an explicit row/region, not a guessed index.
    const identical = ranked.filter(
        (x) => x.name === c.name && x.role === c.role && x.context === c.context,
    );
    if (identical.length > 1) {
        let nested = true;
        for (const other of identical) {
            if (other.ref === c.ref) continue;
            const rel = await snap.frames[c.frame].evaluate(
                ({ a, b, attr }) => {
                    const x = document.querySelector(`[${attr}="${a}"]`),
                        y = document.querySelector(`[${attr}="${b}"]`);
                    return x && y && (x.contains(y) || y.contains(x));
                },
                { a: c.ref, b: other.ref, attr: ATTR },
            );
            if (!rel) nested = false;
        }
        if (!nested)
            throw new Halt('目标不唯一', `存在多个同名同上下文控件“${c.name}”，需要补充区域。`);
    }
    return { locator, control: c, decision };
}
export async function settle(page, ms = 250) {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(ms);
    // Avoid networkidle: polling/WebSocket applications may never become idle.
    await page
        .locator('[aria-busy="true"]:visible,.ant-spin-spinning:visible,.el-loading-mask:visible')
        .first()
        .waitFor({ state: 'hidden', timeout: 20000 })
        .catch(() => {});
    // Site-specific full-screen loading masks (any class) block every real click while a
    // background request hangs; give them a bounded grace period instead of clicking into
    // them for ninety seconds.
    await page
        .waitForFunction(
            () => {
                const vw = innerWidth,
                    vh = innerHeight;
                return ![...document.querySelectorAll('div,section')].some((e) => {
                    const s = getComputedStyle(e),
                        r = e.getBoundingClientRect();
                    return (
                        (s.position === 'fixed' || s.position === 'absolute') &&
                        r.width >= vw * 0.8 &&
                        r.height >= vh * 0.8 &&
                        s.display !== 'none' &&
                        s.visibility !== 'hidden' &&
                        s.pointerEvents !== 'none' &&
                        Number(s.zIndex || 0) >= 100
                    );
                });
            },
            { timeout: 20000 },
        )
        .catch(() => {});
}
export async function assertionTarget(page, name, kind, { rowKey } = {}) {
    const snap = await observe(page);
    let items = snap.controls.filter((c) => c.role !== 'password');
    if (rowKey) items = items.filter((c) => c.rowKey === rowKey);
    if (['empty', 'value'].includes(kind))
        items = items.filter((c) => ['textbox', 'spinbutton', 'combobox'].includes(c.role));
    if (kind === 'checked')
        items = items.filter((c) => ['checkbox', 'radio', 'switch'].includes(c.role));
    if (kind === 'selected') items = items.filter((c) => c.role === 'tab');
    const exact = items.filter((c) => norm(c.name) === norm(name));
    const matches = exact.length
        ? exact
        : items.filter(
              (c) => norm(c.placeholder) === norm(name) || norm(c.name) === norm('请输入' + name),
          );
    if (matches.length !== 1)
        throw new Halt(
            '断言目标不唯一',
            `预期中的“${name}”对应${matches.length}个明确控件，无法证明断言`,
        );
    const control = matches[0],
        locator = snap.frames[control.frame].locator(`[${ATTR}="${control.ref}"]`);
    return { control, locator };
}
export const LIVE_REF = ATTR;

// A date panel hides its days and paging arrows from the generic control pass: they sit
// inside one tabbable wrapper, so closest(selector) excludes them all. Expose just enough
// structure for a deterministic click-only picker: month header, day cells in reading
// order (sequence disambiguates adjacent-month duplicates), and the paging arrows by
// their position around the header.
// Which header arrow to click next, decided only from measurements: `map` records what each arrow
// of this panel actually did ('a' + index → { sign, mag }). Returns the arrow to click, or null
// when nothing this panel offers can reach the target.
export function planArrow(arrows, map, need, distance) {
    const fits = [...map.entries()]
        .filter(([k, v]) => k[0] === 'a' && v.sign === need && v.mag <= distance)
        .sort((a, b) => b[1].mag - a[1].mag);
    const unknown = [...arrows.keys()].filter((k) => !map.has('a' + k));
    // Measuring costs one click, grinding month by month costs twelve, so while the distance is
    // at least a year and an arrow is still unknown, measure instead of grinding.
    if (unknown.length && (!fits.length || (distance >= 12 && fits[0][1].mag < 12))) {
        // A wrong first guess can throw the panel twelve months off target, so measure the arrow
        // the widget itself labels a month step first. That only orders the clicks: the measured
        // delta below stays the sole authority on what any arrow does.
        const monthFirst = unknown.find((k) => arrows[k].unit === 'month');
        return { idx: monthFirst === undefined ? unknown[0] : monthFirst, probing: true };
    }
    if (fits.length)
        return { idx: Number(fits[0][0].slice(1)), probing: false, mag: fits[0][1].mag };
    return null;
}
export async function datePanelState(page) {
    const frames = page.frames();
    for (let fi = 0; fi < frames.length; fi++) {
        const state = await frames[fi]
            .evaluate(() => {
                const visible = (e) => {
                    const s = getComputedStyle(e),
                        r = e.getBoundingClientRect();
                    return (
                        s.display !== 'none' &&
                        s.visibility !== 'hidden' &&
                        r.width > 0 &&
                        r.height > 0
                    );
                };
                const text = (e) =>
                    (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
                const monthCount = (t) => (t.match(/\d{4}\s*年\s*\d{1,2}\s*月/g) || []).length;
                // Range pickers render one wrapper per month side by side; a wrapper holding
                // exactly one month header is one panel, the outer container holds two.
                const panels = [...document.querySelectorAll('div,section,table')].filter((e) => {
                    if (!visible(e)) return false;
                    const t = text(e);
                    return (
                        t.length < 400 &&
                        monthCount(t) === 1 &&
                        /[一二三四五六日]/.test(t.slice(0, 80))
                    );
                });
                const built = panels
                    .map((panel) => {
                        const tlen = text(panel).length;
                        const header = text(panel).match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
                        if (!header) return null;
                        const leaves = [...panel.querySelectorAll('*')].filter(
                            (e) =>
                                visible(e) &&
                                /^\d{1,2}$/.test(text(e)) &&
                                ![...e.querySelectorAll('*')].some((d) => text(d)),
                        );
                        if (leaves.length < 28) return null;
                        const boxes = leaves.map((e) => e.getBoundingClientRect());
                        const order = leaves
                            .map((e, i) => ({ e, i }))
                            .sort(
                                (a, b) =>
                                    Math.round((boxes[a.i].top - boxes[b.i].top) / 8) ||
                                    boxes[a.i].left - boxes[b.i].left,
                            )
                            .map((x) => x.e);
                        const cells = order.map((e, seq) => {
                            const r = e.getBoundingClientRect();
                            return {
                                d: Number(text(e)),
                                seq,
                                cx: r.left + r.width / 2,
                                cy: r.top + r.height / 2,
                            };
                        });
                        const firstOne = cells.findIndex((c) => c.d === 1);
                        const gridTop = boxes[leaves.indexOf(order[0])].top;
                        // The header title ("2026年 3月" / "March 2026") is both the divider and
                        // the thing to avoid: its own buttons open a year/month list and would
                        // destroy the day grid. Anything whose text is part of the title is such a
                        // button — no per-language pattern needed.
                        const titleText = text(panel).match(/\d{4}\s*年\s*\d{1,2}\s*月/)?.[0] || '';
                        const isTitlePart = (t) => t.length >= 2 && titleText.includes(t);
                        const raw = [...panel.querySelectorAll('*')].filter(
                            (e) =>
                                visible(e) &&
                                getComputedStyle(e).cursor === 'pointer' &&
                                text(e).length <= 2 &&
                                !isTitlePart(text(e)) &&
                                e.getBoundingClientRect().bottom <= gridTop + 2 &&
                                ![...e.querySelectorAll('*')].some(
                                    (d) => !['I', 'SPAN', 'SVG'].includes(d.tagName),
                                ),
                        );
                        // A paging button and its inner icon both pass the filter. The icon is a
                        // descendant of the button, not a second control, so drop contained ones —
                        // a structural fact, unlike any pixel tolerance.
                        const arrows = raw
                            .filter((e) => !raw.some((o) => o !== e && o.contains(e)))
                            .sort(
                                (a, b) =>
                                    a.getBoundingClientRect().left - b.getBoundingClientRect().left,
                            )
                            .map((e) => {
                                const r = e.getBoundingClientRect();
                                // The widget's own label for the arrow ("上个月 (Page Up)",
                                // "previous year") says which unit it steps by. It only orders
                                // which arrow gets measured first; the measured delta decides.
                                const label = (
                                    e.getAttribute('title') ||
                                    e.getAttribute('aria-label') ||
                                    ''
                                ).toLowerCase();
                                return {
                                    cx: r.left + r.width / 2,
                                    cy: r.top + r.height / 2,
                                    unit: /年|year/.test(label)
                                        ? 'year'
                                        : /月|month/.test(label)
                                          ? 'month'
                                          : '',
                                };
                            });
                        return {
                            header: { y: Number(header[1]), m: Number(header[2]) },
                            size: tlen,
                            firstOne,
                            cells,
                            // Panel internals re-render on every state change, so refs would
                            // go stale between observation and click; coordinates do not.
                            // Order is enumeration only: which arrow pages by month and which by
                            // year, and in which direction, differs per widget and is measured by
                            // the caller (click, then read the header back), never assumed from
                            // position.
                            arrows,
                        };
                    })
                    .filter(Boolean);
                // Nested wrappers (panel box plus inner grid container) both carry exactly
                // one month header; keep the outermost per month so arrows stay included.
                const byMonth = new Map();
                for (const p of built) {
                    const key = p.header.y + '-' + p.header.m;
                    const prev = byMonth.get(key);
                    if (!prev || p.size > prev.size) byMonth.set(key, p);
                }
                const monthPanels = [...byMonth.values()].sort(
                    (a, b) => a.cells[0]?.cx - b.cells[0]?.cx,
                );
                return monthPanels.length ? { panels: monthPanels } : null;
            })
            .catch(() => null);
        if (state) return { ...state, frame: fi };
    }
    return null;
}

// Typed date fields declare their format in the placeholder or in the value already
// shown; reuse that shape so the typed string looks exactly like a human's.
export function dateFormatFrom(hint) {
    const s = String(hint || '');
    if (/y{2,4}\s*年\s*m{1,2}\s*月\s*d{1,2}\s*日/i.test(s)) return { kind: 'zh' };
    const sep = '([^A-Za-z0-9]*)';
    const ymd = s.match(new RegExp('(y+)' + sep + '(m+)' + sep + '(d+)', 'i'));
    if (ymd) return { kind: 'ymd', sep1: ymd[2] || '-', sep2: ymd[4] || '-' };
    const dmy = s.match(new RegExp('(d+)' + sep + '(m+)' + sep + '(y+)', 'i'));
    if (dmy) return { kind: 'dmy', sep1: dmy[2] || '-', sep2: dmy[4] || '-' };
    const mdy = s.match(new RegExp('(m+)' + sep + '(d+)' + sep + '(y+)', 'i'));
    if (mdy) return { kind: 'mdy', sep1: mdy[2] || '-', sep2: mdy[4] || '-' };
    const v = s.match(/(\d{4})(\D)(\d{1,2})(\D)(\d{1,2})/);
    if (v) return { kind: 'ymd', sep1: v[2], sep2: v[4] };
    return null;
}
export function formatIsoDate(iso, fmt) {
    const [y, m, d] = iso.split('-');
    if (fmt.kind === 'zh') return `${y}年${m}月${d}日`;
    if (fmt.kind === 'dmy') return d + fmt.sep1 + m + fmt.sep2 + y;
    if (fmt.kind === 'mdy') return m + fmt.sep1 + d + fmt.sep2 + y;
    return y + fmt.sep1 + m + fmt.sep2 + d;
}
