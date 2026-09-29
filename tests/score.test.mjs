import test from 'node:test';
import assert from 'node:assert/strict';
import { score, displayable, controlHint, namesClash, optionKeys, declaredEffect } from '../lib/dom.mjs';

// Replay of the intent/name pairs observed on FA and ESP during the 2026-09-28/29 sessions.
const control = (name, extra = {}) => ({ name, placeholder: '', context: '', ...extra });
// What observe() reports for a container grouping form controls: every synonym a case author
// might write, because the classifier only matches the wording the step happens to use.
const FILTER = '筛选区/查询条件/表单';

test('decorated Chinese field names match their core label exactly', () => {
    assert.equal(score('产品名称', control('请输入产品名称')), 132);
    assert.equal(score('订单状态', control('订单状态可多选')), 132);
    assert.equal(score('成本中心', control('成本中心可多选')), 132);
    assert.equal(score('下单时间', control('请选择', { alias: '下单时间：' })), 120);
    assert.equal(score('公司抬头', control('全部', { alias: '公司抬头：' })), 120);
});

test('existing match tiers keep their scores', () => {
    assert.equal(score('编辑', control('编 辑')), 132, 'norm strips the antd two-char space');
    assert.equal(score('全部状态', control('全部状态')), 132);
    assert.equal(score('产品名称', control('请输入产品名称/页码/代码...')), 97);
    assert.equal(score('送货单', control('下载送货单')), 97);
    assert.equal(score('查询', control('查询', { placeholder: '查询' })), 132);
});


test('option labels collapse the antd two-character space', () => {
    assert.equal(displayable('搜 索'), '搜索');
    assert.equal(displayable('登 录'), '登录');
    assert.equal(displayable('Sign in'), 'Sign in', 'latin labels keep their spaces');
    assert.equal(
        displayable('产品 产品目录 搜索'),
        '产品 产品目录 搜索',
        'multi-word names keep their spaces',
    );
    assert.equal(controlHint({ typeWord: '按钮', area: FILTER }), '按钮·' + FILTER);
    assert.equal(controlHint({ typeWord: '链接', area: '菜单栏' }), '链接·菜单栏');
    assert.equal(controlHint({ typeWord: 'option' }), 'option');
    assert.equal(controlHint({}), '');
});

test('a same-name clash is detected across the antd space', () => {
    const link = control('搜索', { role: 'link', typeWord: '链接', area: '菜单栏' });
    const button = control('搜 索', { role: 'button', typeWord: '按钮', area: FILTER });
    assert.equal(namesClash([link, button]), true);
    assert.equal(namesClash([link, control('重置')]), false);
});

test('type·region labels appear only when they tell candidates apart', () => {
    const link = control('搜索', { role: 'link', typeWord: '链接', area: '菜单栏' });
    const button = control('搜 索', { role: 'button', typeWord: '按钮', area: FILTER });
    assert.deepEqual(
        optionKeys([button, link]).map((x) => x.key),
        ['搜索（按钮·' + FILTER + '）', '搜索（链接·菜单栏）'],
    );
    // Every dropdown option shares 选项·下拉列表: the suffix would be pure noise.
    const options = ['杭州安诺过滤器材有限公司', '上海震坤行', '全部'].map((n) =>
        control(n, { role: 'option', typeWord: '选项', area: '下拉列表' }),
    );
    assert.deepEqual(
        optionKeys(options).map((x) => x.key),
        ['杭州安诺过滤器材有限公司', '上海震坤行', '全部'],
    );
    // Same name, same region: fall back to row context so the keys stay unique.
    const rows = [
        control('编辑', { role: 'button', typeWord: '按钮', area: '数据行', context: 'SPU 131318' }),
        control('编辑', { role: 'button', typeWord: '按钮', area: '数据行', context: 'SPU 222222' }),
    ];
    const keys = optionKeys(rows).map((x) => x.key);
    assert.equal(new Set(keys).size, 2);
    assert.ok(keys[0].includes('SPU 131318') && keys[1].includes('SPU 222222'));
});

test('only what a control declares is checked after activating it', () => {
    const url = 'https://x.test/#/price-history';
    assert.equal(declaredEffect(control('搜索按钮'), url), null, 'a plain button promises nothing');
    assert.deepEqual(declaredEffect(control('搜索', { href: '#/search' }), url), {
        kind: 'route',
        href: '#/search',
    });
    assert.equal(
        declaredEffect(control('本页', { href: '#/price-history' }), url),
        null,
        'a link to the current route promises no navigation',
    );
    assert.equal(declaredEffect(control('新窗口', { href: '#/x', newTab: true }), url), null);
    assert.equal(declaredEffect(control('占位', { href: 'javascript:;' }), url), null);
    assert.deepEqual(declaredEffect(control('模块', { expanded: 'false' }), url), {
        kind: 'expanded',
        was: 'false',
    });
    assert.deepEqual(declaredEffect(control('更多', { haspopup: 'menu' }), url), {
        kind: 'popup',
        type: 'menu',
    });
    assert.equal(declaredEffect(control('更多', { haspopup: 'false' }), url), null);
});
