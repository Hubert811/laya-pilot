import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe } from '../lib/language.mjs';
import { dateFormatFrom, formatIsoDate, datePanelState, planArrow } from '../lib/dom.mjs';

test('date verb parses single and range targets without stealing fill steps', () => {
    assert.deepEqual(describe('在“下单时间”选择日期“2026-01-01”到“2026-09-30”'), {
        verb: 'pickDate',
        target: '下单时间',
        value: '2026-01-01',
        to: '2026-09-30',
    });
    assert.equal(describe('在“创建时间”日期框中选择“2026-01-01”').verb, 'pickDate');
    assert.equal(describe('在“下单时间”输入框输入“2026-01-01”').verb, 'fill');
});

test('typed date format follows the placeholder or the value already shown', () => {
    const cases = [
        ['yyyy-MM-dd', '2026-01-01'],
        ['2026-03-28 - 2026-09-28', '2026-01-01'],
        ['yyyy年MM月dd日', '2026年01月01日'],
        ['dd/MM/yyyy', '01/01/2026'],
        ['MM月dd日yyyy年', '01月01日2026'],
        ['请选择', null],
    ];
    for (const [hint, want] of cases) {
        const fmt = dateFormatFrom(hint);
        assert.equal(fmt ? formatIsoDate('2026-01-01', fmt) : null, want, hint);
    }
});

const monthPanel = (el, year, month, left, days) => {
    const arrows = ['«', '‹', '›', '»'].map((glyph, i) => {
        const rect = { top: 10, left: left + i * 30, bottom: 30, width: 20, height: 20 };
        const icon = el('I', glyph, rect, 'pointer');
        // antd wraps a glyph in a button sharing the click point, off by sub-pixel rounding
        return i === 2
            ? el('BUTTON', glyph, { ...rect, bottom: 31, height: 21 }, 'pointer', [icon])
            : icon;
    });
    const pickers = [
        el('BUTTON', `${month}月`, { top: 10, left: left + 160, bottom: 30, width: 30, height: 20 }, 'pointer'),
        el('BUTTON', `${year}年`, { top: 10, left: left + 200, bottom: 30, width: 40, height: 20 }, 'pointer'),
    ];
    const header = el('DIV', `${year}年 ${month}月`, {
        top: 10,
        left: left + 70,
        bottom: 30,
        width: 80,
        height: 20,
    });
    const week = el('DIV', '一 二 三 四 五 六 日', {
        top: 35,
        left,
        bottom: 55,
        width: 340,
        height: 20,
    });
    const cells = days.map((d, i) =>
        el('SPAN', String(d), {
            top: 60 + Math.floor(i / 7) * 24,
            left: left + (i % 7) * 48,
            bottom: 80 + Math.floor(i / 7) * 24,
            width: 40,
            height: 20,
        }),
    );
    const grid = el('DIV', days.join(' '), { top: 60, left, bottom: 220, width: 340, height: 160 }, 'default', cells);
    const panel = el(
        'DIV',
        `${year}年 ${month}月 一 二 三 四 五 六 日 ` + days.join(' '),
        { top: 0, left, bottom: 240, width: 360, height: 240 },
        'default',
        [...arrows, ...pickers, header, week, grid],
    );
    return { panel, arrows, cells };
};

const panelDom = () => {
    const el = (tagName, innerText, rect, cursor = 'default', children = []) => {
        const node = {
            tagName,
            innerText,
            children,
            rect,
            cursor,
            querySelectorAll: (s) => (s === '*' ? descendantsOf(children) : []),
            getBoundingClientRect: () => rect,
            setAttribute: () => {},
            getAttribute: () => null,
            contains: (x) => x === node || children.some((c) => c.contains(x)),
        };
        return node;
    };
    const descendantsOf = (kids) => {
        const out = [];
        const walk = (n) => n.children.forEach((c) => (out.push(c), walk(c)));
        kids.forEach((c) => (out.push(c), walk(c)));
        return out;
    };
    const leftDays = [23, 24, 25, 26, 27, 28, ...Array.from({ length: 31 }, (_, i) => i + 1), 1, 2, 3, 4, 5];
    const rightDays = [31, ...Array.from({ length: 30 }, (_, i) => i + 1), 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const L = monthPanel(el, 2026, 3, 0, leftDays);
    const R = monthPanel(el, 2026, 9, 400, rightDays);
    const outer = el(
        'DIV',
        L.panel.innerText + ' ' + R.panel.innerText,
        { top: 0, left: 0, bottom: 240, width: 760, height: 240 },
        'default',
        [L.panel, R.panel],
    );
    const document = {
        querySelectorAll: (s) =>
            s === 'div,section,table' ? [outer, L.panel, R.panel] : [],
    };
    const getComputedStyle = (e) => ({ display: 'block', visibility: 'visible', cursor: e.cursor });
    return { document, getComputedStyle, L, R };
};

test('date panel exposes month header, sequenced days and positional arrows', async () => {
    const { document, getComputedStyle, L, R } = panelDom();
    const frame = {
        evaluate: async (fn, args) =>
            vm.runInNewContext(`(${fn.toString()})(args)`, { args, document, getComputedStyle }),
    };
    const state = await datePanelState({ frames: () => [frame] });
    assert.equal(state.panels.length, 2, 'outer two-month wrapper must not count as a panel');
    const [left, right] = state.panels;
    assert.equal(left.header.y, 2026);
    assert.equal(left.header.m, 3);
    assert.equal(right.header.m, 9);
    assert.equal(left.firstOne, 6, 'six leading adjacent-month days before the real 1st');
    const day15 = left.cells.find((c) => c.seq === left.firstOne + 14);
    assert.equal(day15.d, 15);
    assert.equal(left.cells.filter((c) => c.d === 1).length, 2, 'real 1st plus next-month copy');
    const center = (e) => e.rect.left + e.rect.width / 2;
    assert.equal(left.arrows.length, 4, 'duplicate icon spans and header month/year buttons add no arrows');
    assert.equal(left.arrows[0].cx, center(L.arrows[0]));
    assert.equal(left.arrows[3].cx, center(L.arrows[3]));
    assert.equal(right.arrows[1].cx, center(R.arrows[1]));
    assert.equal(right.arrows[2].cx, center(R.arrows[2]));
    const vcenter = (e) => e.rect.top + e.rect.height / 2;
    assert.equal(left.arrows[2].cy, vcenter(L.arrows[2]), 'click point keeps both axes');
});

const arrows = (n, units = []) => Array.from({ length: n }, (_, i) => ({ cx: i, cy: 0, unit: units[i] || '' }));

test('the next arrow comes from measurement, never from position', () => {
    // Nothing measured yet: the click is a measurement, whichever arrow it lands on.
    assert.deepEqual(planArrow(arrows(4), new Map(), -1, 2), { idx: 0, probing: true });
    // The widget's own label only orders the first measurement: month step before year step.
    assert.deepEqual(planArrow(arrows(2, ['year', 'month']), new Map(), -1, 2), {
        idx: 1,
        probing: true,
    });
    // antd v4 names neither arrow but marks the year one, so the unmarked one is measured first.
    assert.deepEqual(planArrow(arrows(2, ['year', '']), new Map(), -1, 2), {
        idx: 1,
        probing: true,
    });
    // A measured month arrow that fits is reused.
    assert.deepEqual(planArrow(arrows(4), new Map([['a1', { sign: -1, mag: 1 }]]), -1, 3), {
        idx: 1,
        probing: false,
        mag: 1,
    });
    // Over a year away with an arrow still unknown: spend one click measuring rather than
    // grinding twelve month clicks.
    assert.deepEqual(planArrow(arrows(2), new Map([['a1', { sign: 1, mag: 1 }]]), 1, 20), {
        idx: 0,
        probing: true,
    });
    // Once a year arrow is measured it wins: biggest step that does not overshoot.
    assert.deepEqual(
        planArrow(
            arrows(2),
            new Map([
                ['a0', { sign: 1, mag: 12 }],
                ['a1', { sign: 1, mag: 1 }],
            ]),
            1,
            20,
        ),
        { idx: 0, probing: false, mag: 12 },
    );
    // A year arrow must not overshoot a five-month distance, and nothing else is known.
    assert.equal(planArrow(arrows(1), new Map([['a0', { sign: 1, mag: 12 }]]), 1, 5), null);
    // An arrow that moved nothing is recorded dead (sign 0) and never picked again.
    assert.equal(planArrow(arrows(1), new Map([['a0', { sign: 0, mag: 0 }]]), 1, 5), null);
    // Wrong direction only, and nothing left to measure: this panel cannot help.
    assert.equal(planArrow(arrows(1), new Map([['a0', { sign: -1, mag: 1 }]]), 1, 5), null);
    // An unmeasured arrow is always worth one click, even when a measured one points the
    // wrong way — the other arrow of the same panel may be the one that fits.
    assert.deepEqual(planArrow(arrows(2), new Map([['a0', { sign: -1, mag: 1 }]]), 1, 5), {
        idx: 1,
        probing: true,
    });
});
