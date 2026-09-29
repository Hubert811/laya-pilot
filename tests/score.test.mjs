import test from 'node:test';
import assert from 'node:assert/strict';
import { score } from '../lib/dom.mjs';

// Replay of the intent/name pairs observed on FA and ESP during the 2026-09-28/29 sessions.
const control = (name, extra = {}) => ({ name, placeholder: '', context: '', ...extra });

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

test('replayed synonym families clear the shortlist threshold', () => {
    assert.ok(score('账号 Account Username', control('请输入用户名')) >= 65);
    assert.ok(score('用户名', control('请输入用户名')) >= 120);
    assert.ok(score('公司名称', control('公司抬头')) >= 65);
    assert.ok(score('公司名称', control('全部', { alias: '公司抬头：' })) >= 120);
    // Unrelated vocabulary must not be pulled in by the bounded table.
    assert.ok(score('收货人', control('下单人')) < 65);
});
