// ==UserScript==
// @name         Bili.Dynamic.AutoDel
// @namespace    https://github.com/
// @version      2026.06.01
// @description  删除B站转发的已开奖动态和源动态已被删除的动态。
// @author       monSteRhhe
// @match        http*://*.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_info
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @run-at       document-end
// @require      https://unpkg.com/axios/dist/axios.min.js
// ==/UserScript==
/* globals axios, waitForKeyElements */

(function() {
    'use strict';

    /**
     * 初始化数据的值
     */
    if (GM_getValue('set-unfollow') == undefined) {
        GM_setValue('set-unfollow', false);
    }
    if (GM_getValue('unfollow-list') == undefined
        || GM_getValue('unfollow-list').length != 0) {
        GM_setValue('unfollow-list', []);
    }
    if (GM_getValue('delay-min') == undefined) {
        GM_setValue('delay-min', 1000);
    }
    if (GM_getValue('delay-max') == undefined) {
        GM_setValue('delay-max', 3000);
    }
    if (GM_getValue('show-progress') == undefined) {
        GM_setValue('show-progress', true);
    }
    if (GM_getValue('show-notification') == undefined) {
        GM_setValue('show-notification', false);
    }
    if (GM_getValue('keyword-scope') == undefined) {
        GM_setValue('keyword-scope', 'all');
    }

    /**
     * 延迟函数
     * @param {number} ms 延迟毫秒数
     * @returns Promise
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 获取随机延迟时间 (在用户设定的最小值和最大值之间)
     * @returns 随机延迟毫秒数
     */
    function getRandomDelay() {
        let min = GM_getValue('delay-min'),
            max = GM_getValue('delay-max');
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    /**
     * 进度条状态
     */
    let progressState = {
        el: null,        // DOM 元素
        page: 0,         // 当前页码
        scanned: 0,      // 已扫描动态数
        deleted: 0,      // 已删除数
        errors: 0,       // 失败数
        status: '',      // 当前状态文字
        active: false,   // 是否正在运行
        modeName: '',    // 模式名称
        startTime: 0,    // 任务开始时间
        endTime: 0,      // 任务结束时间
        errorMsg: '',    // 错误信息
    };

    /**
     * 创建进度条面板
     */
    function createProgress() {
        if (progressState.el) return;

        let el = document.createElement('div');
        el.className = 'bili-autodel-progress hide';
        el.innerHTML = `
            <div class="bp-header">
                <span>${GM_info.script.name}</span>
                <button class="bp-close" title="关闭">×</button>
            </div>
            <div class="bp-body">
                <div class="bp-status">准备中…</div>
                <div class="bp-stats">
                    <span>📄 已扫描 <b class="bp-num bp-scanned">0</b> 条</span>
                    <span>🗑️ 已删除 <b class="bp-num bp-deleted">0</b> 条</span>
                    <span>📑 第 <b class="bp-num bp-page">0</b> 页</span>
                </div>
                <div class="bp-bar-track">
                    <div class="bp-bar-fill"></div>
                </div>
            </div>
        `;
        document.body.appendChild(el);
        progressState.el = el;

        el.querySelector('.bp-close').addEventListener('click', () => {
            hideProgress();
        });

        // 触发入场动画
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                el.classList.remove('hide');
            });
        });
    }

    /**
     * 更新进度条内容
     * @param {object} opts - { status, page, scanned, deleted, indeterminate }
     */
    function updateProgress(opts) {
        if (!progressState.el || !GM_getValue('show-progress')) return;

        if (opts.status !== undefined) {
            progressState.el.querySelector('.bp-status').textContent = opts.status;
        }
        if (opts.page !== undefined) {
            progressState.page = opts.page;
            progressState.el.querySelector('.bp-page').textContent = opts.page;
        }
        if (opts.scanned !== undefined) {
            progressState.scanned = opts.scanned;
            progressState.el.querySelector('.bp-scanned').textContent = opts.scanned;
        }
        if (opts.deleted !== undefined) {
            progressState.deleted = opts.deleted;
            progressState.el.querySelector('.bp-deleted').textContent = opts.deleted;
        }

        let track = progressState.el.querySelector('.bp-bar-track');
        if (opts.indeterminate) {
            track.classList.add('bp-bar-indeterminate');
        } else {
            track.classList.remove('bp-bar-indeterminate');
        }
    }

    /**
     * 隐藏并销毁进度条
     */
    function hideProgress() {
        if (!progressState.el) return;
        progressState.el.classList.add('hide');
        setTimeout(() => {
            if (progressState.el && progressState.el.parentNode) {
                progressState.el.parentNode.removeChild(progressState.el);
            }
            progressState.el = null;
            progressState.active = false;
        }, 350);
    }

    /**
     * 重置进度条状态
     */
    function resetProgress() {
        progressState.page = 0;
        progressState.scanned = 0;
        progressState.deleted = 0;
        progressState.errors = 0;
        progressState.status = '';
        progressState.active = true;
        progressState.modeName = '';
        progressState.startTime = Date.now();
        progressState.endTime = 0;
        progressState.errorMsg = '';
    }

    /**
     * 格式化耗时
     * @param {number} ms 毫秒数
     * @returns 格式化后的字符串
     */
    function formatDuration(ms) {
        let sec = Math.floor(ms / 1000);
        if (sec < 60) return sec + ' 秒';
        let min = Math.floor(sec / 60);
        sec = sec % 60;
        if (min < 60) return min + ' 分 ' + sec + ' 秒';
        let hr = Math.floor(min / 60);
        min = min % 60;
        return hr + ' 时 ' + min + ' 分 ' + sec + ' 秒';
    }

    /**
     * 显示任务总结弹窗 (需用户手动关闭)
     * @param {boolean} isError 是否为异常终止
     */
    function showResultSummary(isError) {
        let elapsed = progressState.endTime - progressState.startTime,
            unfollowCount = GM_getValue('set-unfollow') ? GM_getValue('unfollow-list').length : 0;

        let mask = document.createElement('div');
        mask.className = 'result-summary-mask';
        mask.innerHTML = `
            <div class="result-summary">
                <div class="rs-header ${isError ? 'rs-error' : 'rs-success'}">
                    ${isError ? '⚠️ 任务异常终止' : '✅ 任务执行完成'}
                </div>
                <div class="rs-body">
                    <div class="rs-mode">模式：${progressState.modeName}</div>
                    <div class="rs-stats">
                        <div class="rs-stat-item">
                            <span class="rs-stat-num rs-num-scanned">${progressState.scanned}</span>
                            <span class="rs-stat-label">已扫描</span>
                        </div>
                        <div class="rs-stat-item">
                            <span class="rs-stat-num rs-num-deleted">${progressState.deleted}</span>
                            <span class="rs-stat-label">已删除</span>
                        </div>
                        ${progressState.errors > 0 ? `
                        <div class="rs-stat-item">
                            <span class="rs-stat-num rs-num-errors">${progressState.errors}</span>
                            <span class="rs-stat-label">失败</span>
                        </div>` : ''}
                        ${unfollowCount > 0 ? `
                        <div class="rs-stat-item">
                            <span class="rs-stat-num rs-num-unfollowed">${unfollowCount}</span>
                            <span class="rs-stat-label">已取关</span>
                        </div>` : ''}
                    </div>
                    <div class="rs-divider"></div>
                    <div class="rs-detail">📑 共扫描 <b>${progressState.page}</b> 页</div>
                    <div class="rs-detail">⏱️ 耗时 <b>${formatDuration(elapsed)}</b></div>
                    ${isError && progressState.errorMsg ? `<div class="rs-detail" style="color:#f66;">❌ ${progressState.errorMsg}</div>` : ''}
                </div>
                <div class="rs-footer">
                    <button class="${isError ? 'rs-btn-error' : ''}">知道了</button>
                </div>
            </div>
        `;
        document.body.appendChild(mask);

        // 点击按钮关闭
        mask.querySelector('button').addEventListener('click', () => {
            mask.classList.add('hide');
            setTimeout(() => {
                if (mask.parentNode) mask.parentNode.removeChild(mask);
            }, 250);
        });

        // 点击遮罩层也关闭
        mask.addEventListener('click', (e) => {
            if (e.target === mask) {
                mask.querySelector('button').click();
            }
        });
    }

    /**
     * 弹窗样式
     */
    let style = `
        .setting-content {
            color: #000;
            z-index: 10;
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 400px;
            height: 570px;
            background-color: #efecfa;
            border-radius: 10px;
            padding: 10px;
        }
        .setting-content .setting-header {
            font-size: 25px;
            line-height: 25px;
            padding: 5px 20px;
            margin-bottom: 10px;
        }
        .setting-content .setting-body {
            width: 340px;
            height: 440px;
            margin: 0 auto;
            padding: 10px 10px 0 10px;
            background-color: #fff;
            border-radius: 10px;
            padding: 10px;
            font-size: 15px;
            overflow-y: auto;
        }
        .setting-content .setting-item {
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .setting-content .setting-item label {
            flex-shrink: 0;
        }
        .setting-content .delay-input {
            width: 70px;
            height: 24px;
            border: 1px solid #ccc;
            border-radius: 4px;
            padding: 0 6px;
            font-size: 14px;
            text-align: center;
        }
        .setting-content .delay-hint {
            font-size: 12px;
            color: #888;
            margin-top: 4px;
        }
        .setting-content .scope-select {
            height: 28px;
            border: 1px solid #ccc;
            border-radius: 4px;
            padding: 0 6px;
            font-size: 14px;
            background: #fff;
            cursor: pointer;
        }
        .setting-content .setting-footer {
            text-align: right;
            padding: 17px 20px 17px 0;
        }
        .setting-content .setting-footer button {
            cursor: pointer;
            border-radius: 25px;
            background-color: #ffffff;
            border: none;
            height: 30px;
            min-width: 50px;
            padding: 5px 10px;
            font-size: 85%;
        }

        /* 进度条面板 */
        .bili-autodel-progress {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 99999;
            width: 320px;
            background: #fff;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
            color: #333;
            overflow: hidden;
            transition: opacity 0.3s, transform 0.3s;
        }
        .bili-autodel-progress.hide {
            opacity: 0;
            transform: translateY(20px);
            pointer-events: none;
        }
        .bili-autodel-progress .bp-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 14px 6px;
            background: linear-gradient(135deg, #00a1d6, #0084c7);
            color: #fff;
            font-size: 14px;
            font-weight: 600;
        }
        .bili-autodel-progress .bp-header .bp-close {
            cursor: pointer;
            background: none;
            border: none;
            color: #fff;
            font-size: 18px;
            line-height: 1;
            opacity: 0.8;
            padding: 0;
        }
        .bili-autodel-progress .bp-header .bp-close:hover {
            opacity: 1;
        }
        .bili-autodel-progress .bp-body {
            padding: 10px 14px 12px;
        }
        .bili-autodel-progress .bp-status {
            margin-bottom: 8px;
            line-height: 1.4;
            word-break: break-all;
        }
        .bili-autodel-progress .bp-stats {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
            color: #666;
            font-size: 12px;
        }
        .bili-autodel-progress .bp-stats span {
            display: inline-flex;
            align-items: center;
            gap: 3px;
        }
        .bili-autodel-progress .bp-stats .bp-num {
            color: #00a1d6;
            font-weight: 700;
            font-size: 14px;
        }
        .bili-autodel-progress .bp-bar-track {
            width: 100%;
            height: 6px;
            background: #e8e8e8;
            border-radius: 3px;
            overflow: hidden;
        }
        .bili-autodel-progress .bp-bar-fill {
            height: 100%;
            width: 0%;
            background: linear-gradient(90deg, #00a1d6, #23d5d5);
            border-radius: 3px;
            transition: width 0.4s ease;
        }
        .bili-autodel-progress .bp-bar-indeterminate .bp-bar-fill {
            width: 30% !important;
            animation: bp-indeterminate 1.2s ease-in-out infinite;
        }
        @keyframes bp-indeterminate {
            0%   { transform: translateX(-100%); }
            100% { transform: translateX(400%); }
        }

        /* 任务总结弹窗 */
        .result-summary-mask {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.45);
            z-index: 100000;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: rs-mask-in 0.25s ease;
            transition: opacity 0.25s;
        }
        .result-summary-mask.hide {
            opacity: 0;
            pointer-events: none;
        }
        @keyframes rs-mask-in {
            from { opacity: 0; }
            to   { opacity: 1; }
        }
        .result-summary {
            width: 380px;
            background: #fff;
            border-radius: 16px;
            box-shadow: 0 8px 40px rgba(0,0,0,0.2);
            overflow: hidden;
            animation: rs-dialog-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }
        @keyframes rs-dialog-in {
            from { opacity: 0; transform: scale(0.9) translateY(20px); }
            to   { opacity: 1; transform: scale(1) translateY(0); }
        }
        .result-summary .rs-header {
            padding: 18px 24px 14px;
            text-align: center;
            font-size: 18px;
            font-weight: 700;
            color: #fff;
        }
        .result-summary .rs-header.rs-success {
            background: linear-gradient(135deg, #00a1d6, #0084c7);
        }
        .result-summary .rs-header.rs-error {
            background: linear-gradient(135deg, #f66, #e33);
        }
        .result-summary .rs-body {
            padding: 20px 24px;
        }
        .result-summary .rs-mode {
            text-align: center;
            font-size: 13px;
            color: #888;
            margin-bottom: 16px;
        }
        .result-summary .rs-stats {
            display: flex;
            justify-content: space-around;
            margin-bottom: 16px;
        }
        .result-summary .rs-stat-item {
            text-align: center;
        }
        .result-summary .rs-stat-num {
            display: block;
            font-size: 28px;
            font-weight: 800;
            line-height: 1.2;
        }
        .result-summary .rs-stat-num.rs-num-scanned { color: #555; }
        .result-summary .rs-stat-num.rs-num-deleted { color: #00a1d6; }
        .result-summary .rs-stat-num.rs-num-unfollowed { color: #fb7299; }
        .result-summary .rs-stat-num.rs-num-errors   { color: #f66; }
        .result-summary .rs-stat-label {
            font-size: 12px;
            color: #999;
            margin-top: 2px;
        }
        .result-summary .rs-divider {
            height: 1px;
            background: #eee;
            margin: 0 0 14px;
        }
        .result-summary .rs-detail {
            font-size: 13px;
            color: #666;
            line-height: 1.8;
            margin-bottom: 6px;
        }
        .result-summary .rs-detail b {
            color: #333;
        }
        .result-summary .rs-footer {
            padding: 0 24px 20px;
            text-align: center;
        }
        .result-summary .rs-footer button {
            cursor: pointer;
            border: none;
            border-radius: 25px;
            padding: 10px 40px;
            font-size: 15px;
            font-weight: 600;
            color: #fff;
            background: linear-gradient(135deg, #00a1d6, #0084c7);
            transition: transform 0.15s, box-shadow 0.15s;
        }
        .result-summary .rs-footer button:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0,161,214,0.35);
        }
        .result-summary .rs-footer button:active {
            transform: translateY(0);
        }
        .result-summary .rs-footer button.rs-btn-error {
            background: linear-gradient(135deg, #f66, #e33);
        }
        .result-summary .rs-footer button.rs-btn-error:hover {
            box-shadow: 0 4px 12px rgba(255,102,102,0.35);
        }
        `;

    GM_addStyle(style);

    /**
     * 打开设置弹窗
     */
    function openSettingWindow() {
        // 创建弹窗
        let main_window = document.createElement('div');
        main_window.className = 'setting-popup';
        main_window.innerHTML = `
            <div class="setting-content">
                <div class="setting-header">
                    <span>设置<span>
                </div>
                <div class="setting-body">
                    <div class="setting-item">
                        <label>启用取关功能</label>
                        <input type="checkbox" id="set-unfollow" />
                    </div>
                    <div class="setting-item">
                        <label>显示进度条面板</label>
                        <input type="checkbox" id="show-progress" />
                    </div>
                    <div class="setting-item">
                        <label>弹出系统通知</label>
                        <input type="checkbox" id="show-notification" />
                    </div>
                    <div class="setting-item">
                        <label>关键词匹配范围</label>
                        <select class="scope-select" id="keyword-scope">
                            <option value="orig">源动态正文</option>
                            <option value="forward">转发评论</option>
                            <option value="all">源动态正文+转发评论</option>
                        </select>
                    </div>
                    <div class="delay-hint" style="margin-bottom: 12px;">仅对「日期范围+关键词」模式生效</div>
                    <div class="setting-item">
                        <label>请求延迟 (毫秒)</label>
                    </div>
                    <div class="setting-item">
                        <label>最小值:</label>
                        <input type="number" class="delay-input" id="delay-min" min="500" step="100" />
                    </div>
                    <div class="setting-item">
                        <label>最大值:</label>
                        <input type="number" class="delay-input" id="delay-max" min="1000" step="100" />
                    </div>
                    <div class="delay-hint">建议范围: 最小 1000ms ~ 最大 3000ms，随机延迟可降低风控风险</div>
                </div>
                <div class="setting-footer">
                    <button class="setting-close">关闭</button>
                </div>
            </div>
        `;
        document.body.appendChild(main_window);

        // 绑定点击事件
        document.querySelector('.setting-close').addEventListener('click', closeSettingWindow);

        // 设置复选框状态
        let checkbox_list = document.querySelectorAll('.setting-body input[type="checkbox"]');
        for (let node of checkbox_list) {
            node.checked = GM_getValue(node.id);
            node.addEventListener('change', () => {
                GM_setValue(node.id, node.checked);
            })
        }

        // 设置延迟输入框值
        let delay_inputs = document.querySelectorAll('.setting-body input.delay-input');
        for (let node of delay_inputs) {
            node.value = GM_getValue(node.id);
            node.addEventListener('change', () => {
                let val = parseInt(node.value);
                if (isNaN(val) || val < 500) val = 500;
                GM_setValue(node.id, val);
                node.value = val;
            })
        }

        // 设置下拉选择框值
        let select_list = document.querySelectorAll('.setting-body select');
        for (let node of select_list) {
            node.value = GM_getValue(node.id);
            node.addEventListener('change', () => {
                GM_setValue(node.id, node.value);
            })
        }
    }

    /**
     * 关闭弹窗
     */
    function closeSettingWindow() {
        document.body.removeChild(document.querySelector('.setting-popup'));
    }

    /**
     * 获取 X 天前的日期
     * @param {string} num 往前的天数
     * @returns 返回之前的日期，格式YY-MM-DD
     */
    function getBeforeDate(num) {
        let d = new Date();
        d.setDate(d.getDate() - num);
        let year = d.getFullYear(),
            month = d.getMonth() + 1, // getMonth() 返回的值为月份数-1
            day = d.getDate(),
            before_date = year + '-' + (month < 10 ? ('0' + month) : month) + '-' + (day < 10 ? ('0' + day) : day);
        return before_date;
    }

    /**
     * 时间戳转日期
     * @param {number} ts 时间戳 (秒)
     * @returns 返回源动态日期，格式YY-MM-DD
     */
    function timestampToDate(ts) {
        let date = new Date(ts * 1000),
            year = date.getFullYear(),
            month = date.getMonth() + 1,
            day = date.getDate(),
            dyn_date = year + '-' + (month < 10 ? ('0' + month) : month) + '-' + (day < 10 ? ('0' + day) : day);
        return dyn_date;
    }

    /**
     * 获取动态信息
     * @param {string} duid 用户的 DedeUserID
     * @param {string} offset 前往下一页动态的参数
     * @param {string} mode 选择的模式
     * @param {string} input 输入的内容
     */
    async function getDynamics(duid, offset, mode, input) {
        let dynamics_api = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?offset=' + offset + '&host_mid=' + duid, // 动态 API
            lottery_api = 'https://api.vc.bilibili.com/lottery_svr/v1/lottery_svr/lottery_notice?business_type=4&business_id='; // 互动抽奖 API

        // 首次调用时初始化进度条
        if (offset == '') {
            resetProgress();

            if (GM_getValue('show-progress')) {
                createProgress();
            }

            let startMsg = '';
            if (mode == 'auto') {
                startMsg = '自动判断删除互动抽奖动态';
            }
            if (mode == 'user') {
                startMsg = '删除转发用户 ' + input + ' 的动态';
            }
            if (mode == 'days_ago') {
                startMsg = '删除 ' + getBeforeDate(input) + ' 之前的动态';
            }
            if (mode == 'range_keyword') {
                startMsg = '删除 ' + input.startDate + ' ~ ' + input.endDate + ' 的动态';
                if (input.keyword !== '') {
                    startMsg += ' (关键词: ' + input.keyword + ')';
                }
            }
            progressState.modeName = startMsg;
            sendNotification(startMsg + '，开始执行。');
            updateProgress({ status: startMsg + '…', page: 1, scanned: 0, deleted: 0, indeterminate: true });
        }

        try {
            let response = await axios({
                url: dynamics_api,
                withCredentials: true // 跨域使用凭证
            });

            if (response.data.code == 0) {
                let items_list = response.data.data.items; // 动态信息的数组

                updateProgress({ status: '正在扫描第 ' + progressState.page + ' 页 (' + items_list.length + ' 条)…' });

                for (let data of items_list) {
                    if (data.orig != null) {
                        let orig_id_str = data.orig.id_str; // 源动态 ID
                        if (mode == 'auto') {
                            //* “源动态已被作者删除” -> 源动态 ID 为 null
                            if (data.orig.id_str == null) {
                                await sleep(getRandomDelay());
                                await deleteDynamic(data);

                                if (GM_getValue('set-unfollow')
                                    && data.orig.modules.module_author.following) {
                                        saveUnfollowUser(data)
                                }
                            }

                            updateProgress({ status: '查询互动抽奖… (动态 ' + (progressState.scanned + 1) + ')' });
                            await sleep(getRandomDelay());
                            let lottery_resp = await axios({
                                url: lottery_api + orig_id_str
                            });
                            // code = 0，有”互动抽奖”信息
                            if (lottery_resp.data.code == '0') {
                                //* status = 0 -> 未开奖，2 -> 已开奖
                                if (lottery_resp.data.data.status == '2') {
                                    await sleep(getRandomDelay());
                                    await deleteDynamic(data);

                                    if (GM_getValue('set-unfollow')
                                        && data.orig.modules.module_author.following) {
                                            saveUnfollowUser(data)
                                    }
                                }
                            }
                        }

                        if (mode == 'user') {
                            //* 判断用户名 / UID
                            if (input.indexOf(data.orig.modules.module_author.name) != -1
                                || input.indexOf(data.orig.modules.module_author.mid) != -1) {
                                await sleep(getRandomDelay());
                                await deleteDynamic(data);

                                if (GM_getValue('set-unfollow')
                                    && data.orig.modules.module_author.following) {
                                        saveUnfollowUser(data)
                                }
                            }
                        }

                        if (mode == 'days_ago') {
                            let dyn_timestamp = data.orig.modules.module_author.pub_ts, // 源动态发布时间戳 (秒)
                                status = '0';

                            updateProgress({ status: '查询互动抽奖… (动态 ' + (progressState.scanned + 1) + ')' });
                            await sleep(getRandomDelay());
                            let lottery_resp = await axios({
                                url: lottery_api + orig_id_str
                            });
                            if (lottery_resp.data.code == '0') {
                                //* status = 0 -> 未开奖，2 -> 已开奖
                                if (lottery_resp.data.data.status == '2') {
                                    status = '2';
                                }
                            } else {
                                status = '-9999'; // code = -9999，无互动抽奖
                            }

                            //* 比较动态与设定日期 + 排除互动抽奖未开奖的动态
                            if (timestampToDate(dyn_timestamp) <= getBeforeDate(input) && status != '0') {
                                await sleep(getRandomDelay());
                                await deleteDynamic(data);

                                if (GM_getValue('set-unfollow')
                                    && data.orig.modules.module_author.following) {
                                        saveUnfollowUser(data)
                                }
                            }
                        }

                        if (mode == 'range_keyword') {
                            let dyn_timestamp = data.orig.modules.module_author.pub_ts, // 源动态发布时间戳 (秒)
                                dyn_date = timestampToDate(dyn_timestamp),
                                status = '0';

                            //* 日期范围过滤
                            if (dyn_date >= input.startDate && dyn_date <= input.endDate) {

                                //* 关键词过滤 (留空则跳过关键词检查)
                                let keywordMatch = true;
                                if (input.keyword !== '') {
                                    let keywords = input.keyword.split(',').map(k => k.trim()).filter(k => k !== ''),
                                        scope = GM_getValue('keyword-scope'),
                                        orig_text = (data.orig.modules.module_dynamic.desc && data.orig.modules.module_dynamic.desc.text) || '',
                                        dyn_text = (data.modules.module_dynamic.desc && data.modules.module_dynamic.desc.text) || '',
                                        search_text = '';

                                    if (scope === 'orig') {
                                        search_text = orig_text;
                                    } else if (scope === 'forward') {
                                        search_text = dyn_text;
                                    } else {
                                        search_text = orig_text + ' ' + dyn_text;
                                    }

                                    keywordMatch = keywords.some(kw => search_text.indexOf(kw) != -1);
                                }

                                if (keywordMatch) {
                                    updateProgress({ status: '查询互动抽奖… (动态 ' + (progressState.scanned + 1) + ')' });
                                    await sleep(getRandomDelay());
                                    let lottery_resp = await axios({
                                        url: lottery_api + orig_id_str
                                    });
                                    if (lottery_resp.data.code == '0') {
                                        //* status = 0 -> 未开奖，2 -> 已开奖
                                        if (lottery_resp.data.data.status == '2') {
                                            status = '2';
                                        }
                                    } else {
                                        status = '-9999'; // code = -9999，无互动抽奖
                                    }

                                    //* 排除未开奖的抽奖动态
                                    if (status != '0') {
                                        await sleep(getRandomDelay());
                                        await deleteDynamic(data);

                                        if (GM_getValue('set-unfollow')
                                            && data.orig.modules.module_author.following) {
                                                saveUnfollowUser(data)
                                        }
                                    }
                                }
                            }
                        }
                    }

                    progressState.scanned++;
                    updateProgress({ scanned: progressState.scanned });
                }

                offset = response.data.data.offset;
                if (offset != '') {
                    progressState.page++;
                    updateProgress({ status: '翻页中… 等待延迟', page: progressState.page });
                    await sleep(getRandomDelay()); // 翻页延迟
                    await getDynamics(duid, offset, mode, input);
                } else {
                    let finishMsg = '完成！共扫描 ' + progressState.scanned + ' 条，删除 ' + progressState.deleted + ' 条。';
                    sendNotification(finishMsg);
                    updateProgress({ status: finishMsg, indeterminate: false });

                    // 取关
                    if (GM_getValue('set-unfollow')) {
                        await unfollowUser();
                    }

                    // 记录结束时间，隐藏进度条，弹出任务总结
                    progressState.endTime = Date.now();
                    hideProgress();
                    showResultSummary(false);
                }
            }
        } catch (err) {
            console.error('[' + GM_info.script.name + ']', '请求出错:', err);
            sendNotification('请求出错，请查看控制台日志。');
            progressState.errorMsg = err.message || String(err);
            progressState.endTime = Date.now();
            hideProgress();
            showResultSummary(true);
        }
    }

    /**
     * 删除动态
     * @param {object} item 每条动态的信息
     */
    async function deleteDynamic(item) {
        //* csrf 参数 -> 从 cookie 获取 bili_jct
        let delete_api = 'https://api.bilibili.com/x/dynamic/feed/operate/remove?csrf=' + getCookie(' bili_jct'),
            re_id_str = item.id_str; // 转发动态的 ID
        console.log('[' + GM_info.script.name + ']', 'https://www.bilibili.com/opus/' + re_id_str); // 控制台输出动态网址

        try {
            updateProgress({ status: '删除动态 ' + re_id_str + '…' });
            let response = await axios({
                method: 'post',
                url: delete_api,
                withCredentials: true,
                data: {
                    dyn_id_str: re_id_str
                }
            });
            if (response.data.code == '0') {
                progressState.deleted++;
                sendNotification(re_id_str + ' 删除成功。');
                updateProgress({ deleted: progressState.deleted });
            } else {
                progressState.errors++;
                console.warn('[' + GM_info.script.name + ']', '删除接口返回异常:', response.data);
                updateProgress({ status: '⚠️ 删除失败(' + response.data.code + '): ' + re_id_str });
            }
        } catch (err) {
            console.error('[' + GM_info.script.name + ']', '删除动态失败:', err);
            progressState.errors++;
            updateProgress({ status: '⚠️ 删除失败: ' + re_id_str });
        }
    }

    /**
     * 删除动态
     * @param {object} data 每条动态的信息
     */
    function saveUnfollowUser(data) {
        let unfollow_arr = GM_getValue('unfollow-list'),
            uid = data.orig.modules.module_author.mid;
        if (unfollow_arr.indexOf(uid) == -1) {
            unfollow_arr.push(uid);
            GM_setValue('unfollow-list', unfollow_arr);
        }
    }

    /**
     * 取关用户
     */
    async function unfollowUser() {
        let unfollow_api = 'https://api.bilibili.com/x/relation/modify',
            unfollow_list = GM_getValue('unfollow-list');

        for (let uid of unfollow_list) {
            await sleep(getRandomDelay());
            try {
                let response = await axios({
                    method: 'post',
                    url: unfollow_api,
                    withCredentials: true,
                    data: {
                        fid: uid,
                        act: 2,
                        re_src: 11,
                        spmid: '333.999.0.0',
                        csrf: getCookie(' bili_jct')
                    }
                });
                if (response.data.code == '0') {
                    sendNotification(uid + ' 取关成功。');
                }
            } catch (err) {
                console.error('[' + GM_info.script.name + ']', '取关失败:', err);
            }
        }
    }

    /**
     * 显示通知
     * @param {string} msg 发送的通知消息
     */
    function sendNotification(msg) {
        // 始终输出到控制台
        console.log('[' + GM_info.script.name + ']', msg);

        // 系统弹窗通知 (默认关闭)
        if (GM_getValue('show-notification')) {
            GM_notification({
                text: msg,
                title: GM_info.script.name,
                image: GM_info.script.icon,
                timeout: 1500,
            });
        }
    }

    /**
     * 获取 cookie
     * @param {string} key 所需的 cookie 的键
     * @returns 返回 cookie 的值
     */
    function getCookie(key) {
        let cookieArr = document.cookie.split(';');
        for (var i = 0; i < cookieArr.length; i++) {
            if (cookieArr[i].split('=')[0] == key) {
                let value = cookieArr[i].split('=')[1];
                return value;
            }
        }
    }

    /**
     * 启动
     * @param {string} mode 选择的模式
     */
    function start(mode) {
        let duid = getCookie(' DedeUserID'),
            input = '';

        if(duid == undefined) {
            sendNotification('未检测到登录状态。'); // 未登录时 DedeUserID 未定义
        } else {
            if (mode == 'user') {
                input = prompt('请输入想要删除的用户名或 UID (多个则用英文逗号「,」进行分割) :');
                if (input == '' || input == undefined) {
                    sendNotification('没有输入内容！')
                    return false
                }
            }
            if (mode == 'days_ago') {
                input = prompt('请输入想要删除多少天前的动态 (整数即可) :');
                if (!isNaN(input)) {
                    sendNotification('输入错误！')
                    return false;
                }
            }
            if (mode == 'range_keyword') {
                let startDate = prompt('请输入起始日期 (格式 YYYY-MM-DD，如 2024-01-01) :');
                if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
                    sendNotification('起始日期格式错误！');
                    return false;
                }
                let endDate = prompt('请输入结束日期 (格式 YYYY-MM-DD，如 2024-12-31) :');
                if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
                    sendNotification('结束日期格式错误！');
                    return false;
                }
                if (startDate > endDate) {
                    sendNotification('起始日期不能晚于结束日期！');
                    return false;
                }
                let keyword = prompt('请输入关键词 (可留空，留空则不限制关键词，多个关键词用英文逗号分隔) :') || '';
                input = { startDate, endDate, keyword: keyword.trim() };
            }

            getDynamics(duid, '', mode, input);
        }
    }

    /**
     * 删除源动态已开奖 / 已删除对应的转发动态
     */
    GM_registerMenuCommand('自动判断', () => {
        start('auto');
    })

    /**
     * 删除源动态用户名 / UID对应的转发动态
     */
    GM_registerMenuCommand('指定用户', () => {
        start('user');
    })

    /**
     * 删除X天前发布的源动态对应的转发动态
     */
    GM_registerMenuCommand('删除X天前的转发动态', () => {
        start('days_ago');
    })

    /**
     * 按日期范围和关键词删除转发动态
     */
    GM_registerMenuCommand('日期范围+关键词', () => {
        start('range_keyword');
    })

    /**
     * 打开设置弹窗
     */
    GM_registerMenuCommand('打开设置', () => {
        openSettingWindow();
    })
})();