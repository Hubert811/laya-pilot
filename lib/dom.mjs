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
    const ranked = candidates
        .map((c) => ({ ...c, rank: score(intent, c) }))
        .sort((a, b) => b.rank - a.rank);
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
    const keyed = shortlist.map((c, i) => ({
        key:
            c.name.slice(0, 36) +
            (shortlist.filter((x) => x.name === c.name).length > 1
                ? ' [' + (c.context.slice(0, 16) || c.role) + '] #' + i
                : ''),
        control: c,
    }));
    const criteria = Object.fromEntries(
        keyed.map(({ key, control: c }) => [
            key,
            prefix +
                (c.alias
                    ? c.alias.replace(/[：:]$/, '') + '（' + c.name.slice(0, 24) + '）'
                    : c.name.slice(0, 38)),
        ]),
    );
    const stopKey = en ? 'Stop' : '停止';
    criteria[stopKey] = en ? 'Do not perform any action' : '不执行';
    const decision = await laya.choose(prefix + intent, criteria, {
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
        .waitFor({ state: 'hidden', timeout: 5000 })
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
                        const arrows = [...panel.querySelectorAll('*')]
                            .filter(
                                (e) =>
                                    visible(e) &&
                                    getComputedStyle(e).cursor === 'pointer' &&
                                    text(e).length <= 2 &&
                                    e.getBoundingClientRect().bottom <= gridTop + 2 &&
                                    ![...e.querySelectorAll('*')].some(
                                        (d) => !['I', 'SPAN', 'SVG'].includes(d.tagName),
                                    ),
                            )
                            .sort(
                                (a, b) =>
                                    a.getBoundingClientRect().left - b.getBoundingClientRect().left,
                            )
                            .map((e) => {
                                const r = e.getBoundingClientRect();
                                return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
                            });
                        const left = arrows.slice(0, 2),
                            right = arrows.slice(-2);
                        return {
                            header: { y: Number(header[1]), m: Number(header[2]) },
                            size: tlen,
                            firstOne,
                            cells,
                            // Panel internals re-render on every state change, so refs would
                            // go stale between observation and click; coordinates do not.
                            arrows: {
                                prev: left.length > 1 ? left[1] : left[0] || null,
                                next: right.length > 1 ? right[0] : right.at(-1) || null,
                            },
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
