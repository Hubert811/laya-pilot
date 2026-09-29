import fs from 'node:fs/promises';
import path from 'node:path';
import { Halt, expectation, lines, variables, parseData, norm, quoted } from './language.mjs';
import {
    observe,
    target,
    settle,
    assertionTarget,
    discoverRowLabels,
    datePanelState,
    planArrow,
    declaredEffect,
    popupOpen,
    dateFormatFrom,
    formatIsoDate,
} from './dom.mjs';
import { waitForReady, readTables } from './readiness.mjs';
import { expandStep, semanticStep, scopeNames, approvalOperation } from './planner.mjs';
const writeName =
    /(?:删除|移除|保存|提交|新增|创建|修改|编辑|上线|下线|授权|发布|导入|发送|支付|购买|确定|确认|应用|delete|remove|save|submit|create|edit|publish|send|pay|buy|import|confirm|apply)/i;
export class Engine {
    constructor(page, laya, config) {
        this.page = page;
        this.laya = laya;
        this.config = config;
        this.events = [];
        this.actions = 0;
        this.current = null;
        this.failures = [];
        this.navigationCount = 0;
        this.baselines = new Map();
        this.phase = 'setup';
        this.navFailureStart = 0;
        this.dirtyAreas = new Map();
        // antd-pro tables render the empty placeholder while the list request is still in
        // flight, so "placeholder visible" is not a terminal signal. Track in-flight XHR
        // instead: an empty table is only trustworthy once nothing is pending.
        this.inflight = 0;
        page.on('request', (r) => {
            if (['xhr', 'fetch'].includes(r.resourceType())) this.inflight++;
        });
        const settleInflight = () => {
            this.inflight = Math.max(0, this.inflight - 1);
        };
        page.on('response', settleInflight);
        page.on('requestfailed', settleInflight);
        page.on('response', (r) => {
            if (r.url().includes('/product/list') || /\/list\?/.test(r.url())) {
                const entry = { status: r.status(), url: r.url().split('?')[1] || '' };
                r.json()
                    .then((j) => {
                        const list =
                            j?.list || j?.data?.list || (Array.isArray(j?.data) ? j.data : []);
                        entry.total = j?.total ?? j?.data?.total ?? null;
                        entry.rows = Array.isArray(list) ? list.length : null;
                    })
                    .catch((e) => {
                        entry.bodyError = String(e.message).slice(0, 100);
                    });
                (this.listResponses ||= []).push(entry);
                if (this.listResponses.length > 6) this.listResponses.shift();
            }
            if (r.status() >= 400) {
                const u = new URL(r.url());
                this.failures.push({
                    case: this.current?.key,
                    path: u.pathname,
                    status: r.status(),
                    resourceType: r.request().resourceType(),
                });
            }
        });
    }
    async chooseTarget(name, kind = 'click', extras = {}) {
        const actual = this.config.labels?.[name] || name;
        if (actual !== name) console.log('  站点名称映射：' + name + ' → ' + actual);
        // A rewritten name means the step text no longer contains what the control is called on
        // this site, so it must not be used as the question.
        if (actual !== name) delete extras.stepText;
        return target(this.page, this.laya, actual, {
            kind,
            meta: { case: this.current?.key, step: this.actions, original_target: name },
            minProbability: this.config.minProbability,
            minMargin: this.config.minMargin,
            observeRetries: this.config.observeRetries,
            observeInterval: this.config.observeInterval,
            ...extras,
        });
    }
    guard(control, step) {
        if (control.role === 'tab') return;
        if (!writeName.test(control.name)) return;
        if (!this.config.allowWrite)
            throw new Halt(
                '写入未启用',
                `当前为只读执行，步骤涉及“${control.name}”；在专用测试环境使用--allow-write才能执行。`,
            );
        if (!writeName.test(step))
            throw new Halt('动作与用例不符', '模型选择写入操作，但原始步骤没有对应写入意图。');
    }
    // Every real click goes through here: a bounded attempt, then name whatever sits on the
    // click point instead of dying in a silent ninety-second actionability timeout.
    async clickWithDiagnosis(locator, name) {
        try {
            await locator.click({ timeout: 15000 });
        } catch (e) {
            // Three distinct causes, three distinct messages: a detached node (the page
            // re-rendered after we resolved the target), a point outside the viewport (nothing
            // scrolled it into view), or a real element sitting on top of the click point.
            const box = await locator.boundingBox().catch(() => null);
            let cover = '元素已不在页面上，多半是定位之后页面重新渲染了';
            if (box) {
                const hit = await this.page
                    .evaluate(
                        ({ x, y }) => {
                            const el = document.elementFromPoint(x, y);
                            return el
                                ? String(el.className || el.tagName).replace(/\s+/g, '.').slice(0, 60)
                                : null;
                        },
                        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
                    )
                    .catch(() => undefined);
                cover =
                    hit === undefined
                        ? '读取点击点失败'
                        : hit === null
                          ? '点击点在视口之外，元素没有被滚动到可见位置'
                          : '点击点上覆盖着 ' + hit;
            }
            throw new Halt(
                '点击被阻挡',
                '目标“' +
                    name +
                    '”在15s内不可点击：' +
                    cover +
                    '；在途请求 ' +
                    this.inflight +
                    ' 个',
            );
        }
    }
    // What the control itself declares will happen is the only postcondition a generic runner can
    // check: an aria-expanded toggle, an aria-haspopup popup, a link's route change. A plain
    // button declares nothing, and inventing a postcondition for it would be guesswork — there the
    // case's own expected results are the proof. Returns true, or why the action did not take.
    // Did the click produce anything observable? An app can intercept a link (a download, a
    // JS-handled route, a new tab) and legitimately leave the address bar alone, so a missing
    // declared effect only counts as a dead click when nothing else happened either.
    async observableChange(before) {
        if (this.page.url() !== before.url) return true;
        if (await popupOpen(this.page)) return true;
        if (this.page.context().pages().length > before.pages) return true;
        return this.inflight > 0;
    }
    async confirmEffect(control, locator, before) {
        const declared = declaredEffect(control, before.url);
        if (!declared) return true;
        if (declared.kind === 'expanded') {
            const now = await locator.getAttribute('aria-expanded').catch(() => null);
            // The node was replaced by a re-render: nothing left to read, which is not a failure.
            if (now === null) return true;
            return now !== declared.was
                ? true
                : 'aria-expanded 仍是 ' + now + '，点击没有展开或收起';
        }
        if (await this.observableChange(before)) return true;
        return declared.kind === 'route'
            ? '链接指向 ' + declared.href + '，点击后地址、弹层、标签页和在途请求都没有变化'
            : '控件声明 aria-haspopup=' + declared.type + '，点击后没有任何弹层或跳转';
    }
    // Click, then check. Only a route change is retried: clicking a toggle twice closes whatever
    // the first click opened, and a write is never clicked twice at all.
    async clickAndConfirm(locator, control, name, step) {
        const writable = writeName.test(control.name) || writeName.test(step);
        let before = { url: this.page.url(), pages: this.page.context().pages().length };
        await this.clickWithDiagnosis(locator, name);
        await settle(this.page, this.config.delay);
        let reason = await this.confirmEffect(control, locator, before);
        if (reason !== true && !writable && declaredEffect(control, before.url)?.kind === 'route') {
            console.log('  ' + reason + '；重试一次');
            before = { url: this.page.url(), pages: this.page.context().pages().length };
            await this.clickWithDiagnosis(locator, name);
            await settle(this.page, this.config.delay);
            reason = await this.confirmEffect(control, locator, before);
        }
        if (reason !== true) throw new Halt('操作未生效', reason);
    }
    async directClick(name, step) {
        await this.revealRowMenu(name);
        const rowKey = await this.targetRow(name);
        const found = await this.chooseTarget(name, 'click', { rowKey, stepText: step });
        this.guard(found.control, step);
        if (
            this.pendingPreconditions?.length &&
            writeName.test(found.control.name) &&
            found.control.role !== 'tab'
        )
            throw new Halt(
                '前置条件未验证',
                '业务写入前仍有未证明的前提：' + this.pendingPreconditions.join('；'),
            );
        if (found.control.href) {
            const u = new URL(found.control.href, this.page.url());
            if (!this.config.origins.includes(u.origin))
                throw new Halt('目标地址超出测试范围', '链接不属于本次配置的测试站点。');
        }
        console.log('  Laya → ' + found.control.name + ' [' + found.control.role + ']');
        this.navFailureStart = this.failures.length;
        try {
            await this.clickAndConfirm(found.locator, found.control, name, step);
        } catch (e) {
            // A late response can rebuild the list between resolving the target and clicking it,
            // detaching the node. A human looks again and clicks again; so does this, once.
            if (!(e instanceof Halt) || e.category !== '点击被阻挡') throw e;
            console.log('  ' + e.message + '；重新定位后再点一次');
            const again = await this.chooseTarget(name, 'click', { rowKey, stepText: step });
            await this.clickAndConfirm(again.locator, again.control, name, step);
        }
        await this.ready();
        return found.control;
    }
    async revealRowMenu(name) {
        if (!this.rowKey) return;
        const snap = await observe(this.page);
        if (
            snap.controls.some(
                (c) =>
                    norm(c.name) === norm(name) &&
                    (c.rowKey || !['menuitem', 'option'].includes(c.role)),
            )
        )
            return;
        const more = snap.controls.filter(
            (c) => c.rowKey === this.rowKey && /^(?:图标:\s*more|更多|more)$/i.test(c.name),
        );
        if (more.length !== 1) return;
        // This menu is click-triggered. Merely hovering revealed transient content
        // that disappeared during model inference, causing repeated 9-second waits.
        const menuItem = snap.controls.find(
            (c) => !c.rowKey && norm(c.name) === norm(name) && c.role === 'menuitem',
        );
        if (menuItem) {
            const item = await assertionTarget(this.page, name, 'visible');
            await item.locator.hover();
            return;
        }
        const found = await this.chooseTarget(more[0].name, 'click', { rowKey: this.rowKey });
        await this.clickWithDiagnosis(found.locator, more[0].name);
        await this.page.waitForTimeout(180);
        this.events.push({
            phase: this.phase,
            action: 'open-menu',
            text: '展开当前记录的更多操作',
            rowKey: this.rowKey,
        });
    }
    async targetRow(name) {
        if (!this.rowKey) return undefined;
        const snap = await observe(this.page);
        // Dialog controls supersede the list-row binding. Exact global navigation
        // remains global; other operation buttons stay in the chosen record.
        if (!snap.controls.some((c) => c.rowKey === this.rowKey)) return undefined;
        if (snap.controls.some((c) => !c.rowKey && norm(c.name) === norm(name))) return undefined;
        return this.rowKey;
    }
    async bindRow(text) {
        // antd-pro renders the empty placeholder while the list XHR is still in flight, so
        // the placeholder is not a terminal signal. Accept "empty" only once nothing is pending.
        let snap = await observe(this.page);
        const hasRows = () => snap.controls.some((c) => c.rowKey && c.context);
        // The list endpoint returns the whole dataset and the table renders it client-side:
        // rows land ~7s after the response with no network in between, and the empty
        // placeholder renders before the response arrives. So neither the placeholder nor
        // "no pending XHR" is terminal; accept empty only after 20s of quiet placeholder.
        // Poll budget: 500ms x 60 = 30s, anchored on row controls appearing.
        let quiet = 0;
        for (let i = 0; i < 60 && !hasRows(); i++) {
            await this.page.waitForTimeout(500);
            snap = await observe(this.page);
            if (hasRows()) break;
            const empty = await this.page.evaluate(() =>
                [...document.querySelectorAll('.ant-table-placeholder,.ant-empty')].some(
                    (e) => e.offsetParent,
                ),
            );
            quiet = empty && this.inflight === 0 ? quiet + 1 : 0;
            if (quiet >= 40) break;
        }
        const all = [
                ...new Map(
                    snap.controls.filter((c) => c.rowKey && c.context).map((c) => [c.rowKey, c]),
                ).values(),
            ];
        const state = text.match(/(?:找到|存在)(.+?)状态/)?.[1];
        const quotedName = text.match(/名称(?:为|含)[「“"]([^」”"]+)[」”"]/)?.[1];
        const permission = text.includes('只读') ? '只读' : text.includes('读写') ? '读写' : null;
        const eligible = all.filter(
            (c) =>
                (!state || c.context.includes(state)) &&
                (!quotedName || c.context.includes(quotedName)) &&
                (!permission || c.context.includes(permission)),
        );
        if (!eligible.length) {
            const inputs = await this.page.evaluate(() =>
                [...document.querySelectorAll('input,textarea')].filter((i) => i.offsetParent)
                    .map((i) => (i.placeholder || i.name || i.getAttribute('aria-label') || i.type) +
                        '=' + JSON.stringify(i.value))
                    .slice(0, 12),
            );
            const diag = {
                rows: snap.controls.filter((c) => c.rowKey).length,
                inflight: this.inflight,
                inputs,
                listResponses: this.listResponses || [],
            };
            throw new Halt(
                '缺少测试数据',
                '当前列表没有符合步骤条件的可定位记录：' + text + ' | ' + JSON.stringify(diag),
            );
        }
        // Arbitrary-record UI checks may use the first eligible row; mutations may
        // only select a specifically named record or explicitly supplied fixture.
        const writes = /(?:点击|执行|确认|提交).{0,12}(?:删除|保存|上线|下线|发布)/.test(
            this.current?.steps || '',
        );
        const fixture = this.config.data?.recordName;
        const chosen = fixture ? eligible.find((c) => c.context.includes(fixture)) : eligible[0];
        if (!chosen) throw new Halt('缺少测试数据', '未找到配置的独立测试记录：' + fixture);
        if (writes && !fixture && !quotedName)
            throw new Halt(
                '缺少独立测试数据',
                '该用例会修改记录；需先准备独立测试数据并通过--data的recordName指定，不能对现有任意记录操作',
            );
        this.rowKey = chosen.rowKey;
        this.events.push({
            phase: this.phase,
            action: 'bind-row',
            text,
            rowKey: chosen.rowKey,
            record: chosen.context,
            selection: fixture ? 'configured-fixture' : 'first-eligible-live-row',
        });
        console.log('  绑定记录：' + chosen.context.slice(0, 100));
        await discoverRowLabels(this.page, this.rowKey);
    }
    // Dates are picked the way a human picks them: real clicks on the panel, or typed
    // text in the component's own format for editable fields. Never inject a value
    // behind the widget's back, and never trust the action without reading it back.
    async pickDate(fieldIntent, fromIso, toIso) {
        const found = await this.chooseTarget(fieldIntent, 'click');
        const shape = await found.locator
            .evaluate((e) => ({
                readonly: e.readOnly === true,
                ph: e.getAttribute('placeholder') || '',
                val: 'value' in e ? String(e.value) : '',
            }))
            .catch(() => null);
        const fmt =
            shape && !shape.readonly && !toIso ? dateFormatFrom(shape.ph || shape.val) : null;
        if (fmt) {
            const typed = formatIsoDate(fromIso, fmt);
            await found.locator.fill(typed);
            await this.page.keyboard.press('Enter');
            await settle(this.page, this.config.delay);
            const now = await found.locator.inputValue().catch(() => '');
            if (!now.includes(typed))
                throw new Halt('操作未生效', '日期输入未被组件接受，实际值：' + now);
            this.events.push({
                phase: this.phase,
                action: 'pick-date',
                text: fieldIntent + ' ' + fromIso,
                mode: 'typed',
            });
            return;
        }
        await this.clickWithDiagnosis(found.locator, fieldIntent);
        await settle(this.page, this.config.delay);
        const picks = [fromIso, toIso].filter(Boolean);
        // Arrow semantics come from clicking them, and the widget's layout does not change
        // between the two ends of a range, so one measurement table serves both picks.
        const learned = new Map();
        for (const [index, iso] of picks.entries()) {
            if (index > 0 && !(await datePanelState(this.page))) {
                await this.clickWithDiagnosis(found.locator, fieldIntent);
                await settle(this.page, this.config.delay);
            }
            await this.pickOneDate(iso, fieldIntent, index, learned);
        }
        const now = shape ? await found.locator.inputValue().catch(() => '') : '';
        const digits = (s) => String(s).replace(/\D/g, '');
        if (shape && !digits(now).includes(digits(fromIso)))
            throw new Halt('操作未生效', '日期选择后输入框未包含目标日期，实际值：' + now);
        this.events.push({
            phase: this.phase,
            action: 'pick-date',
            text: fieldIntent + ' ' + picks.join('~'),
            mode: 'panel-click',
        });
    }
    async pickOneDate(iso, fieldIntent, prefer = 0, learned = new Map()) {
        const tgt = Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7));
        const day = Number(iso.slice(8, 10));
        const monthOf = (p) => p.header.y * 12 + p.header.m;
        // Which arrow pages by month, which by year, and which way each goes, differs per widget
        // and is not readable from the layout. So every arrow is measured once — click, read the
        // header back — and the measurement, cached per panel, drives every later choice.
        let index = prefer;
        for (let i = 0; i < 40; i++) {
            const st = await datePanelState(this.page);
            if (!st?.panels.length)
                throw new Halt(
                    '日期面板未打开',
                    '点击“' + fieldIntent + '”后没有找到月历面板，无法按日期定位',
                );
            const shown = st.panels.findIndex((p) => monthOf(p) === tgt);
            // A single-panel picker has no index 1; prefer is a starting hint, not a promise.
            index = shown >= 0 ? shown : Math.min(index, st.panels.length - 1);
            const panel = st.panels[index];
            const cur = monthOf(panel);
            console.log(
                '  日期面板[' +
                    index +
                    '/' +
                    st.panels.length +
                    '] ' +
                    st.panels.map((p) => p.header.y + '-' + p.header.m).join(' | ') +
                    ' → 目标 ' +
                    iso,
            );
            if (cur === tgt) {
                // Reading order separates real days from adjacent-month copies: the real
                // day D sits exactly firstOne + D - 1 cells after the first "1".
                const hit = panel.cells.find((c) => c.d === day && c.seq === panel.firstOne + day - 1);
                if (!hit)
                    throw new Halt(
                        '日期格缺失',
                        panel.header.y + '-' + panel.header.m + ' 面板里没有第 ' + day + ' 天',
                    );
                await this.page.mouse.click(hit.cx, hit.cy);
                console.log('  日期点击 ' + iso + ' @' + Math.round(hit.cx) + ',' + Math.round(hit.cy));
                await settle(this.page, this.config.delay);
                return;
            }
            const need = tgt > cur ? 1 : -1;
            const distance = Math.abs(tgt - cur);
            const map = learned.get(index) || new Map();
            learned.set(index, map);
            const plan = planArrow(panel.arrows, map, need, distance);
            if (!plan) {
                // Every arrow of this panel is measured and none can reach the target. While any
                // panel still has an unmeasured arrow, go measure it — the other half of a range
                // picker usually pages the opposite way. Once all of them are known and none
                // fits, the widget genuinely cannot reach this date.
                const nextPanel = st.panels.findIndex((p, pi) => {
                    const m = learned.get(pi) || new Map();
                    return p.arrows.some((_, k) => !m.has('a' + k));
                });
                if (nextPanel >= 0) {
                    index = nextPanel;
                    continue;
                }
                throw new Halt(
                    '日期翻页不可用',
                    '面板 ' +
                        panel.header.y +
                        '-' +
                        panel.header.m +
                        ' 的箭头都无法向' +
                        (need > 0 ? '后' : '前') +
                        '翻页到 ' +
                        iso,
                );
            }
            const arrow = panel.arrows[plan.idx];
            if (!arrow)
                throw new Halt(
                    '日期翻页不可用',
                    '面板头部没有找到翻页箭头，当前 ' + panel.header.y + '-' + panel.header.m,
                );
            console.log(
                '  日期翻页 ' +
                    (plan.probing
                        ? '试探'
                        : (need > 0 ? '前进' : '后退') + '×' + plan.mag) +
                    ' 箭头#' +
                    plan.idx +
                    (arrow.unit ? '(' + arrow.unit + ')' : '') +
                    ' @' +
                    Math.round(arrow.cx) +
                    ',' +
                    Math.round(arrow.cy),
            );
            await this.page.mouse.click(arrow.cx, arrow.cy);
            await this.page.waitForTimeout(250);
            const after = await datePanelState(this.page);
            const now = after?.panels[index] ? monthOf(after.panels[index]) : cur;
            const delta = now - cur;
            // A click that moves nothing is a disabled or decorative arrow. Record it as unusable
            // (sign 0 fits no direction) so it is never probed again, instead of retrying it.
            map.set(
                'a' + plan.idx,
                delta === 0 ? { sign: 0, mag: 0 } : { sign: Math.sign(delta), mag: Math.abs(delta) },
            );
        }
        throw new Halt('日期翻页超限', '40 次翻页内未找到 ' + iso);
    }
    async ready() {
        return waitForReady(this.page, {
            timeout: this.config.pageTimeout || 18000,
            failures: () => this.failures.slice(this.navFailureStart),
        });
    }
    async navigate(url, { force = false } = {}) {
        const u = new URL(url, this.config.url);
        if (!['http:', 'https:'].includes(u.protocol) || !this.config.origins.includes(u.origin))
            throw new Halt('目标地址超出测试范围', '步骤网址必须属于本次测试站点');
        const changed = force || this.page.url() !== u.href;
        if (changed) {
            this.navFailureStart = this.failures.length;
            this.navigationCount++;
            await this.page.goto(u.href, { waitUntil: 'domcontentloaded' });
        }
        await this.ready();
        return changed;
    }
    async showArea(name) {
        const snap = await observe(this.page),
            tabs = snap.controls.filter((c) => c.role === 'tab' && norm(c.name) === norm(name));
        if (tabs.length !== 1) throw new Halt('页签无法确认', '找不到唯一页签：' + name);
        if (!tabs[0].selected) {
            const c = await this.directClick(name, '切换到' + name + 'Tab');
            this.events.push({
                phase: this.phase,
                action: 'click',
                text: '切换到' + name + 'Tab',
                control: { name: c.name, role: c.role },
                url: this.page.url(),
            });
        }
    }
    async closeOverlay() {
        const modal = this.page
            .locator('dialog[open],[role="dialog"]:visible,.ant-drawer-open .ant-drawer-content')
            .last();
        if (!(await modal.isVisible().catch(() => false))) return;
        // A header Close and a footer 关闭 can coexist. Prefer the explicit header
        // close label, then exact alternatives; never select a generic confirmation.
        for (const name of ['Close', '关闭', 'Cancel', '取消']) {
            const close = modal
                .getByRole('button', { name, exact: true })
                .filter({ visible: true });
            if ((await close.count()) !== 1) continue;
            await close.click();
            await modal.waitFor({ state: 'hidden', timeout: this.config.assertTimeout || 4000 });
            await this.ready();
            return;
        }
        throw new Halt('页面复位未完成', '存在未关闭弹窗，无法唯一确定取消/关闭按钮');
    }
    async resetCase(url) {
        this.phase = 'setup';
        const desired = new URL(url, this.config.url),
            current = new URL(this.page.url());
        const sameModule =
            desired.origin === current.origin &&
            desired.pathname === current.pathname &&
            !desired.search &&
            !desired.hash;
        // Returning to the login portal would throw away the authenticated landing page;
        // such cases reach their module through an explicit navigate step instead.
        const startedAtLogin =
            this.config.authenticated &&
            !!this.config.loginUrl &&
            desired.href === new URL(this.config.loginUrl, this.config.url).href;
        const changed =
            (sameModule || startedAtLogin) && !this.config.reloadEachCase
                ? (await this.ready(), false)
                : await this.navigate(url, { force: !!this.config.reloadEachCase });
        const key = new URL(url, this.config.url).href;
        if (!this.baselines.has(key)) {
            const snap = await observe(this.page);
            this.baselines.set(
                key,
                snap.controls.filter((c) => c.role === 'tab' && c.selected).map((c) => c.name),
            );
            return;
        }
        if (!changed) {
            await this.closeOverlay();
            for (const area of this.dirtyAreas.values()) {
                for (const name of area) await this.showArea(name);
                const snap = await observe(this.page),
                    resets = snap.controls.filter(
                        (c) => c.role === 'button' && /^(重置|Reset)$/i.test(c.name),
                    );
                if (resets.length === 1) {
                    const c = await this.directClick(resets[0].name, '重置查询条件');
                    this.events.push({
                        phase: 'setup',
                        action: 'reset',
                        scope: area,
                        control: { name: c.name, role: c.role },
                    });
                } else {
                    await this.navigate(url, { force: true });
                    console.log('  上条改变了表单且页面没有重置入口，刷新一次恢复初始状态');
                    break;
                }
            }
            for (const name of this.baselines.get(key)) await this.showArea(name);
        }
        this.dirtyAreas.clear();
    }
    async checkPrecondition(p, c) {
        if (/^(?:无|无特殊要求|none|n\/a)$/i.test(p)) return;
        if (/^(?:用户)?已登录(?:系统)?[，,]?\s*$/i.test(p)) {
            if (
                !this.config.authenticated ||
                (await this.page.locator('input[type="password"]:visible').count())
            )
                throw new Halt('登录前提不足', '本轮没有完成登录流程，或页面仍显示密码框');
            return;
        }
        const loginWith = p.match(/^(?:用户)?已登录(?:系统)?[，,](.+)$/);
        if (loginWith) {
            await this.checkPrecondition('已登录系统', c);
            return this.checkPrecondition(loginWith[1], c);
        }
        const role = p.match(/^(?:仅)?拥有(.+?)(只读|读写)权限$/);
        if (role) {
            const t = await readTables(this.page),
                i = t.headers.findIndex((h) => h.includes('权限'));
            if (i >= 0 && t.rows.some((r) => norm(r[i]) === norm(role[2]))) return;
            throw new Halt(
                '缺少权限场景',
                '当前列表没有证明所需的' + role[2] + '权限记录；需要对应授权或测试身份',
            );
        }
        if (/^进入/.test(p)) {
            await this.step(p);
            return;
        }
        const permission = p.match(/^已拥有(.+)菜单权限$/);
        if (permission) {
            const leaf = permission[1].split(/[_>＞→]/).at(-1),
                snap = await observe(this.page);
            if (snap.controls.some((x) => norm(x.name) === norm(leaf))) return;
            throw new Halt(
                '前置条件未验证',
                '未找到菜单“' +
                    leaf +
                    '”；先确认页面已加载且页面语言与Excel一致，不能据此判定账号无权限',
            );
        }
        const exists = p.match(/^系统存在(.+)数据$/);
        if (exists) {
            const moduleName = c.title.split(/\s+-\s+/)[0];
            let constraint = exists[1].replaceAll(moduleName, '').replace(/的/g, '');
            const snap = await observe(this.page),
                tabs = snap.controls.filter((x) => x.role === 'tab'),
                areas = tabs.filter((x) => constraint.includes(x.name)).map((x) => x.name);
            for (const area of areas) constraint = constraint.replaceAll(area, '');
            constraint = constraint.replace(/和|、/g, '');
            const state = constraint.match(/^(.+)状态$/),
                permissionValue = constraint.match(/^(.+)权限$/),
                named = constraint.match(/^名称含[「“"](.+)[」”"]$/);
            if (state && /^(?:各种|所有|多种|不同)$/.test(state[1]))
                throw new Halt(
                    '前置条件未验证',
                    '尚不能证明状态覆盖完整：' + p + '；需逐状态准备样本，不能把“各种”当成状态名称',
                );
            if (constraint && !state && !permissionValue && !named)
                throw new Halt(
                    '前置条件未验证',
                    '尚不能证明这个业务前提：' + p + '；请提供明确的数据条件，未将它当作通过',
                );
            const column = state ? '状态' : permissionValue ? '权限' : named ? '名称' : null,
                value = state?.[1] || permissionValue?.[1] || named?.[1];
            const check = async () => {
                const t = await readTables(this.page);
                if (!t.rows.length) return false;
                if (!column) return true;
                const index = t.headers.findIndex((h) => h.includes(column));
                return (
                    index >= 0 &&
                    t.rows.some((r) =>
                        named ? r[index]?.includes(value) : norm(r[index]) === norm(value),
                    )
                );
            };
            if (areas.length) {
                for (const area of areas) {
                    await this.showArea(area);
                    if (!(await check()))
                        throw new Halt('前置条件未验证', area + '当前可见记录未证明：' + p);
                }
                return;
            }
            if (await check()) return;
            // Data may live behind another visible tab. Probe at most three tabs, never all pages.
            for (const area of tabs.filter((t) => !t.selected).slice(0, 3)) {
                await this.showArea(area.name);
                if (await check()) return;
            }
            throw new Halt(
                '前置条件未验证',
                '当前可见记录未证明：' + p + '；没有查询全量后台数据，不能断言系统不存在该数据',
            );
        }
        const check = await this.verify(p);
        if (check.status !== '通过')
            throw new Halt('前置条件未验证', '未能验证前提：' + p + '；' + check.reason);
    }
    async step(text) {
        const snap = await observe(this.page);
        let specs = expandStep(text, { controls: snap.controls, area: this.area });
        if (!specs.length)
            specs = await semanticStep(text, snap, this.laya, {
                meta: { case: this.current?.key },
                minProbability: this.config.minProbability,
                minMargin: this.config.minMargin,
            });
        for (const spec of specs) await this.executeStep(text, spec);
    }
    async executeStep(text, spec) {
        if (++this.actions > this.config.maxSteps)
            throw new Halt('达到步骤上限', '本用例达到最大操作次数，停止继续尝试');
        console.log('  步骤：' + text);
        if (spec.verb === 'pickDate') {
            await this.pickDate(spec.target, spec.value, spec.to);
            return;
        }
        if (spec.verb === 'bindRow') {
            await this.bindRow(text);
            return;
        }
        if (spec.verb === 'assertStep') {
            const actual = await this.verify(spec.target);
            this.events.push({ phase: this.phase, action: 'step-assertion', text, ...actual });
            if (actual.status !== '通过')
                throw new Halt(
                    actual.status === '失败' ? '步骤预期不符' : '执行能力不足',
                    actual.reason,
                );
            return;
        }
        if (spec.verb === 'emptyRequired') {
            const snap = await observe(this.page),
                fields = snap.controls.filter(
                    (c) =>
                        ['textbox', 'spinbutton', 'combobox'].includes(c.role) &&
                        !c.disabled &&
                        !c.readonly,
                );
            if (!fields.length || fields.some((c) => c.value))
                throw new Halt(
                    '前置条件未验证',
                    '当前必填字段为空尚未证明，不提交可能带有默认值的表单',
                );
            this.events.push({
                phase: this.phase,
                action: 'observe-empty-fields',
                text,
                fields: fields.map((c) => c.name),
            });
            return;
        }
        if (spec.verb === 'path') {
            const snap = await observe(this.page),
                leaf = spec.path.at(-1),
                current = new URL(this.page.url());
            const here = snap.controls.find((c) => {
                if (norm(c.name) !== norm(leaf) || !c.href) return false;
                const u = new URL(c.href, current);
                return (
                    u.href === current.href ||
                    (!u.search &&
                        !u.hash &&
                        u.origin === current.origin &&
                        u.pathname === current.pathname)
                );
            });
            if (here) {
                const event = {
                    phase: this.phase,
                    text,
                    action: 'already-on-page',
                    control: { name: here.name, role: here.role },
                    url: this.page.url(),
                };
                this.events.push(event);
                console.log('  已在目标页面，复用当前DOM');
                return event;
            }
        }
        // Explicit verbs need no second model vote ("点击查看" was being confused
        // with the observation verb). Laya still selects the real DOM target below.
        const verb = spec.verb;
        let control;
        if (verb === 'navigate') {
            if (!spec.target) throw new Halt('缺少测试数据', '没有明确网址');
            await this.navigate(spec.target);
        } else if (verb === 'path') {
            // If a path's final destination is already visible, choose it directly.
            const snap = await observe(this.page),
                leaf = spec.path.at(-1);
            const candidates = snap.controls.filter((c) => norm(c.name) === norm(leaf));
            if (candidates.length === 1) control = await this.directClick(leaf, text);
            else for (const part of spec.path) control = await this.directClick(part, text);
        } else if (verb === 'observe') {
            const names = quoted(text);
            if (names.length === 1 && /按钮/.test(text)) {
                await this.revealRowMenu(names[0]);
                const found = await assertionTarget(this.page, names[0], 'visible', {
                    rowKey: await this.targetRow(names[0]),
                });
                control = found.control;
                this.observedName = names[0];
            }
            await settle(this.page, this.config.delay);
        } else if (verb === 'press') {
            if (spec.value.toLowerCase() === 'enter' && !this.config.allowWrite)
                throw new Halt('写入未启用', 'Enter可能提交当前表单；未启用写入时不猜测其行为');
            await this.page.keyboard.press(spec.value);
            await settle(this.page, this.config.delay);
        } else if (verb === 'click') {
            if (!this.rowKey && /列表(?:中)?点击/.test(text)) await this.bindRow(text);
            control = await this.directClick(spec.target, text);
        } else {
            if (['fill', 'clear', 'select', 'check', 'uncheck'].includes(verb)) {
                const snap = await observe(this.page),
                    area = snap.controls
                        .filter((c) => c.role === 'tab' && c.selected)
                        .map((c) => c.name);
                this.dirtyAreas.set(JSON.stringify(area), area);
            }
            const found = await this.chooseTarget(spec.target, verb, {
                value: spec.value,
                rowKey: await this.targetRow(spec.target),
                allowDisabled: verb === 'hover',
            });
            control = found.control;
            if (verb === 'fill' || verb === 'clear') {
                const want = verb === 'clear' ? '' : spec.value;
                for (let attempt = 1; ; attempt++) {
                    await found.locator.fill(want);
                    if ((await found.locator.inputValue()) === want) break;
                    if (attempt >= 2)
                        throw new Halt('操作未生效', '填写后的实际输入值不一致');
                    console.log('  填写未生效，重试一次');
                }
            } else if (verb === 'select') {
                if (control.tag === 'select') {
                    await found.locator.selectOption({ label: spec.value });
                    // A native select reports the option's value, not its label, so read the
                    // selected option's text — that is what the case wrote.
                    const shown = await found.locator
                        .evaluate((el) => el.options?.[el.selectedIndex]?.text ?? '')
                        .catch(() => null);
                    if (shown !== null && !norm(shown).includes(norm(spec.value)))
                        throw new Halt(
                            '操作未生效',
                            '选择后控件显示“' + shown + '”，不是“' + spec.value + '”',
                        );
                } else {
                    // antd-style selects hang their open handler on the selector container
                    // while a selected-value span covers the inner input: a locator click on
                    // the input is intercepted forever, a human click on the box works.
                    const box =
                        control.tag !== 'select'
                            ? await found.locator.boundingBox().catch(() => null)
                            : null;
                    // The list has to be open before an option can be chosen. A click that lands
                    // before the widget is ready leaves the page unchanged, and the option step
                    // then scores every button on the page 0 and fails on a gate that hides the
                    // real cause, so check the popup instead of assuming the click worked.
                    for (let attempt = 1; ; attempt++) {
                        if (box)
                            await this.page.mouse.click(
                                box.x + box.width / 2,
                                box.y + box.height / 2,
                            );
                        else await this.clickWithDiagnosis(found.locator, spec.target);
                        await settle(this.page, this.config.delay);
                        if ((await popupOpen(this.page)) === 'listbox') break;
                        if (attempt >= 3)
                            throw new Halt(
                                '下拉未展开',
                                '点击“' +
                                    spec.target +
                                    '”' +
                                    attempt +
                                    ' 次后仍没有候选列表，无法选择“' +
                                    spec.value +
                                    '”',
                            );
                        console.log('  下拉未展开，重试第 ' + attempt + ' 次');
                    }
                    const option = await this.chooseTarget(spec.value, 'option');
                    await this.clickWithDiagnosis(option.locator, spec.value);
                    await settle(this.page, this.config.delay);
                    // The chosen option must say it is selected, or the list must have closed on
                    // it; a multi-select keeps the list open, so either signal counts.
                    const picked = await option.locator
                        .getAttribute('aria-selected')
                        .catch(() => null);
                    if (picked !== 'true' && (await popupOpen(this.page)) === 'listbox')
                        throw new Halt(
                            '操作未生效',
                            '点击选项“' + spec.value + '”后它仍未被选中，候选列表也没有关闭',
                        );
                }
            } else if (verb === 'check' || verb === 'uncheck') {
                const want = verb === 'check';
                if (['input'].includes(control.tag))
                    await found.locator.setChecked(want);
                else if (control.checked !== want)
                    await this.clickWithDiagnosis(found.locator, spec.target);
                await settle(this.page, this.config.delay);
                for (let attempt = 1; attempt <= 2; attempt++) {
                    const state = await found.locator.isChecked().catch(() => null);
                    // A widget that exposes no checkable state cannot be read back; that is not
                    // the same as a failed action, so it is left to the case's assertions.
                    if (state === null || state === want) break;
                    if (attempt === 2)
                        throw new Halt(
                            '操作未生效',
                            (want ? '勾选' : '取消勾选') +
                                '“' +
                                spec.target +
                                '”后状态仍是 ' +
                                state,
                        );
                    console.log('  勾选状态未变，重试一次');
                    await this.clickWithDiagnosis(found.locator, spec.target);
                    await settle(this.page, this.config.delay);
                }
            } else if (verb === 'hover') await found.locator.hover();
            await settle(this.page, this.config.delay);
        }
        const event = {
            phase: this.phase,
            text,
            action: verb,
            ...(control
                ? { control: { name: control.name, role: control.role, context: control.context } }
                : {}),
            url: this.page.url(),
        };
        this.events.push(event);
        return event;
    }
    async verify(text) {
        const spec = expectation(text),
            page = this.page;
        if (spec.kind === 'unsupported')
            return {
                text,
                status: '未验证',
                reason: '当前断言语法无法完整解释；未用Laya评分代替结果证明',
            };
        if (spec.scope) await this.showArea(spec.scope);
        let actual,
            passed = false;
        if (spec.kind === 'tooltip') {
            if (!this.observedName)
                return {
                    text,
                    status: '未验证',
                    reason: '没有明确的悬停目标，不能把任意提示作为本条证据',
                };
            await this.revealRowMenu(this.observedName);
            const found = await assertionTarget(page, this.observedName, 'visible', {
                rowKey: await this.targetRow(this.observedName),
            });
            await found.locator.hover();
            await page.waitForTimeout(400);
            actual = [
                ...new Set(
                    (
                        await page
                            .locator(
                                '[role="tooltip"]:visible,.ant-tooltip:visible,.el-tooltip__popper:visible',
                            )
                            .allTextContents()
                    ).map((s) => s.trim()),
                ),
            ];
            passed = actual.some((s) => s.includes(spec.target));
        } else if (spec.kind === 'controlVisible') {
            const snap = await observe(page);
            actual = snap.controls
                .filter((c) => norm(c.name) === norm(spec.target))
                .map((c) => ({ name: c.name, role: c.role }));
            passed = actual.length === 1;
        } else if (spec.kind === 'dialog') {
            const dialogs = page.locator(
                'dialog[open]:visible,[role="dialog"]:visible,.ant-drawer-open .ant-drawer-content:visible',
            );
            actual = await dialogs.allTextContents();
            passed = actual.some((s) => s.includes(spec.target));
        } else if (spec.kind === 'fixedColumns') {
            actual = await page
                .getByRole('columnheader')
                .filter({ visible: true })
                .evaluateAll(
                    (els, names) =>
                        Object.fromEntries(
                            names.map((name) => [
                                name,
                                els
                                    .filter((e) => e.innerText.trim() === name)
                                    .map((e) => ({
                                        position: getComputedStyle(e).position,
                                        left: getComputedStyle(e).left,
                                        right: getComputedStyle(e).right,
                                        fixedLeft: !!e.closest('.ant-table-fixed-left'),
                                        fixedRight: !!e.closest('.ant-table-fixed-right'),
                                    })),
                            ]),
                        ),
                    [spec.left, spec.right],
                );
            passed =
                actual[spec.left]?.some(
                    (c) => c.fixedLeft || (c.position === 'sticky' && c.left !== 'auto'),
                ) &&
                actual[spec.right]?.some(
                    (c) => c.fixedRight || (c.position === 'sticky' && c.right !== 'auto'),
                );
        } else if (spec.kind === 'columnValues') {
            const t = await readTables(page),
                i = t.headers.findIndex((h) => h.includes(spec.column));
            actual = i < 0 ? [] : t.rows.map((r) => r[i]);
            passed =
                actual.length > 0 &&
                actual.every((v) => spec.values.some((w) => norm(w) === norm(v)));
        } else if (spec.kind === 'fieldAbsent' || spec.kind === 'fields') {
            const snap = await observe(page),
                fields = snap.controls.filter(
                    (c) => ['textbox', 'combobox'].includes(c.role) && c.inPanel,
                );
            actual = fields.map((c) => ({ name: c.name, role: c.role }));
            passed =
                spec.kind === 'fieldAbsent'
                    ? !fields.some((c) => c.name.includes(spec.target))
                    : spec.targets.every((t) =>
                          fields.some((c) => c.role === t.role && c.name.includes(t.name)),
                      );
        } else if (spec.kind === 'visible' || spec.kind === 'absent') {
            // Check visible rendered text, not hidden DOM or a model's opinion.
            const locator = page.getByText(spec.target, { exact: false }).filter({ visible: true });
            if (spec.kind === 'visible')
                await locator
                    .first()
                    .waitFor({ timeout: this.config.assertTimeout })
                    .catch(() => {});
            else
                await locator
                    .first()
                    .waitFor({ state: 'hidden', timeout: this.config.assertTimeout })
                    .catch(() => {});
            actual = await locator.count();
            passed = spec.kind === 'visible' ? actual > 0 : actual === 0;
        } else if (spec.kind === 'tabs') {
            const snap = await observe(page),
                tabs = snap.controls.filter((c) => c.role === 'tab');
            actual = tabs.map((c) => c.name);
            passed = actual.length === spec.count && spec.targets.every((t) => actual.includes(t));
        } else if (spec.kind === 'columns') {
            actual = await page
                .getByRole('columnheader')
                .filter({ visible: true })
                .allTextContents();
            passed = spec.targets.every((t) => actual.some((a) => a.trim() === t));
        } else if (spec.kind === 'rowcount') {
            const tables = page.getByRole('table').filter({ visible: true });
            if ((await tables.count()) !== 1)
                return {
                    text,
                    status: '未验证',
                    reason: '存在多个表格，需要写明目标表格，不能猜测行数',
                };
            await page
                .waitForFunction(
                    (expected) => {
                        const visible = (e) => {
                            const r = e.getBoundingClientRect(),
                                s = getComputedStyle(e);
                            return (
                                r.width > 0 &&
                                r.height > 0 &&
                                s.visibility !== 'hidden' &&
                                s.display !== 'none'
                            );
                        };
                        const all = [...document.querySelectorAll('table,[role="table"]')].filter(
                            visible,
                        );
                        return (
                            all.length === 1 &&
                            [...all[0].querySelectorAll('tbody tr')].filter(visible).length ===
                                expected
                        );
                    },
                    spec.value,
                    { timeout: this.config.assertTimeout },
                )
                .catch(() => {});
            actual = await tables.locator('tbody tr').filter({ visible: true }).count();
            passed = actual === spec.value;
        } else if (spec.kind === 'url') {
            actual = page.url();
            passed = actual.includes(spec.target);
        } else {
            const found = await assertionTarget(page, spec.target, spec.kind, {
                rowKey: await this.targetRow(spec.target),
            });
            if (['value', 'empty'].includes(spec.kind)) {
                actual = await found.locator.inputValue();
                passed = actual === (spec.kind === 'empty' ? '' : spec.value);
            } else if (['disabled', 'enabled'].includes(spec.kind)) {
                actual = found.control.disabled;
                passed = spec.kind === 'disabled' ? actual : !actual;
            } else if (spec.kind === 'checked') {
                actual = found.control.checked;
                passed = actual === true;
            } else if (spec.kind === 'selected') {
                actual = found.control.selected;
                passed = actual === true;
            }
        }
        return {
            text,
            status: passed ? '通过' : '失败',
            kind: spec.kind,
            actual,
            reason: passed ? '明确断言满足' : '实际页面状态与该预期不符，需核对需求或定位证据',
        };
    }
    async runCase(c) {
        this.current = c;
        this.actions = 0;
        this.events = [];
        this.rowKey = null;
        this.area = null;
        this.observedName = null;
        this.pendingPreconditions = [];
        const started = Date.now();
        const failuresAt = this.failures.length,
            navAt = this.navigationCount;
        let touchedPage = false;
        const result = {
            ...c,
            status: '未执行',
            reason: '',
            category: '',
            actions: [],
            assertions: [],
            started_at: new Date().toISOString(),
        };
        try {
            if (c.import_error) throw new Halt('Excel内容不明确', c.import_error);
            if (!this.config.includeApproval && approvalOperation(c))
                throw new Halt(
                    '按要求跳过审批',
                    '用例包含审批流程操作或审批开关，不执行；仅展示审批状态的用例不按关键词排除',
                );
            const data = { ...parseData(c.data), ...this.config.data, runId: this.config.runId };
            const steps = lines(variables(c.steps, data)),
                expected = lines(variables(c.expected, data)),
                preconditions = lines(variables(c.preconditions, data));
            if (!steps.length || !expected.length)
                throw new Halt('用例内容缺失', '需要明确的操作步骤和预期结果');
            touchedPage = true;
            await this.resetCase(c.url || this.config.url);
            this.phase = 'precondition';
            const scopeSnapshot = await observe(this.page);
            const titleAreas = scopeNames(
                c.title + '\n' + steps.filter((s) => /^切换/.test(s) && s.includes('/')).join('\n'),
                scopeSnapshot.controls,
            );
            if (titleAreas.length === 1) await this.showArea(titleAreas[0]);
            result.precondition_checks = [];
            for (const p of preconditions) {
                try {
                    await this.checkPrecondition(p, c);
                    result.precondition_checks.push({ text: p, status: '通过' });
                } catch (e) {
                    if (
                        e.category !== '前置条件未验证' ||
                        !/(?:尚不能证明|语法无法完整解释)/.test(e.message)
                    )
                        throw e;
                    this.pendingPreconditions.push(p);
                    result.precondition_checks.push({
                        text: p,
                        status: '待补证',
                        reason: e.message,
                    });
                    console.log('  前提待补证，继续可观察步骤：' + p);
                }
            }
            // Repeat read-only scenarios explicitly titled for multiple live tabs.
            // Never multiply potentially persistent writes across scopes automatically.
            if (titleAreas.length > 1 && this.config.allowWrite)
                throw new Halt(
                    '多页签写入范围不明确',
                    '用例标题涉及多个页签且允许写入，请拆成独立用例后执行',
                );
            for (const area of titleAreas.length ? titleAreas : [null]) {
                this.phase = 'step';
                this.area = area;
                this.rowKey = null;
                if (area) {
                    await this.closeOverlay();
                    await this.showArea(area);
                    console.log('  用例范围：' + area);
                }
                for (const text of steps) await this.step(text);
                this.phase = 'assertion';
                for (const text of expected) {
                    try {
                        result.assertions.push({ ...(await this.verify(text)), scope: area });
                    } catch (e) {
                        if (e.category === '模型API错误') throw e;
                        result.assertions.push({
                            text,
                            scope: area,
                            status: '未验证',
                            reason: e.message,
                        });
                    }
                }
            }
            for (const p of this.pendingPreconditions)
                result.assertions.push({
                    text: '前提：' + p,
                    status: '未验证',
                    reason: '已继续执行可观察步骤，但该前提仍缺少证据，不能计为通过',
                });
            result.status = result.assertions.some((a) => a.status === '失败')
                ? '失败'
                : result.assertions.some((a) => a.status === '未验证')
                  ? '部分验证'
                  : '通过';
            result.category =
                result.status === '失败'
                    ? '断言不符合预期，需复核'
                    : result.status === '部分验证'
                      ? '部分预期尚不能自动验证'
                      : '无';
            result.reason =
                result.assertions
                    .filter((a) => a.status !== '通过')
                    .map((a) => a.text + '：' + a.reason)
                    .join('；') || '所有步骤已执行，所有预期断言通过';
        } catch (e) {
            result.status = this.events.some(
                (x) => x.phase === 'step' && x.action !== 'already-on-page',
            )
                ? '部分执行（未完成）'
                : '跳过（未完成）';
            result.category = e.category || '执行器异常';
            result.reason = e.message;
        }
        result.actions = this.events;
        result.duration_ms = Date.now() - started;
        result.network_errors = this.failures.slice(failuresAt);
        result.page_navigations = this.navigationCount - navAt;
        this.lastCaseUiChanged = this.events.some(
            (x) =>
                x.phase === 'step' &&
                ['fill', 'select', 'check', 'uncheck', 'clear'].includes(x.action),
        );
        result.evidence_scope = result.actions.length
            ? '操作后的页面快照'
            : '本条没有完成动作；截图仅表示停止时浏览器页面';
        if (result.status !== '通过' && result.network_errors.some((x) => x.status === 401)) {
            result.category = '登录会话失效';
            result.reason += '；捕获HTTP401，需重新登录';
        }
        if (
            ['页面资源加载失败', '页面尚未就绪'].includes(result.category) &&
            result.network_errors.some((x) => x.status >= 500)
        ) {
            result.category = '环境接口故障';
            result.reason += '；页面未就绪且捕获HTTP5xx，不能据此判定产品功能错误';
        }
        const stem = `${String(c.id).replace(/[^\w\u4e00-\u9fff-]/g, '_')}-${c.row}`;
        if (touchedPage) {
            result.screenshot = 'evidence/' + stem + '.png';
            await this.page
                .screenshot({ path: path.join(this.config.out, result.screenshot) })
                .catch(() => {});
            const snap = await observe(this.page);
            await fs.writeFile(
                path.join(this.config.out, 'evidence', stem + '-controls.json'),
                JSON.stringify({ url: snap.url, controls: snap.controls }, null, 2),
            );
        }
        return result;
    }
}
