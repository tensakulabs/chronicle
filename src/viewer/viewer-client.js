(function() {
    // ── State ──
    var ws = null;
    var selectedFile = null;
    var treeData = null;
    var allTreeData = null;
    var codeTreeData = null;
    var currentTreeMode = 'code';
    var currentTab = 'signatures';
    var allFiles = [];
    var expandedDirs = {};
    var currentTasksData = null;
    var currentTaskGroup = 'status';
    var currentTagFilters = [];
    var currentStatusFilters = [];

    // ── Utility ──
    function esc(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;').replace(/\\'/g, '&#39;');
    }

    function statusLabel(status) {
        var labels = { active: 'In Progress', backlog: 'Backlog', done: 'Done', cancelled: 'Cancelled' };
        return labels[status] || status;
    }

    // ── WebSocket ──
    function connect() {
        ws = new WebSocket('ws://' + location.host);
        ws.onopen = function() { console.log('[Chronicle] Connected'); };
        ws.onclose = function() { setTimeout(connect, 1000); };
        ws.onmessage = function(e) { handleMessage(JSON.parse(e.data)); };
    }

    function send(msg) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }

    function handleMessage(msg) {
        if (msg.type === 'tree') {
            if (msg.mode === 'code') codeTreeData = msg.data;
            else allTreeData = msg.data;
            if (msg.mode === currentTreeMode) {
                treeData = msg.data;
                renderTree(msg.data);
                updateHeaderStats(msg.data);
            }
        } else if (msg.type === 'refresh') {
            codeTreeData = msg.codeTree;
            allTreeData = msg.allTree;
            treeData = currentTreeMode === 'code' ? codeTreeData : allTreeData;
            renderTree(treeData);
            updateHeaderStats(treeData);
            if (selectedFile) {
                send({ type: 'getSignature', file: selectedFile });
                send({ type: 'getFileContent', file: selectedFile });
            }
        } else if (msg.type === 'signature') {
            renderSignature(msg.data, msg.file);
        } else if (msg.type === 'fileContent') {
            renderSource(msg.data, msg.file);
        } else if (msg.type === 'tasks') {
            renderTasks(msg.data);
        }
    }

    // ── Header Stats ──
    function updateHeaderStats(tree) {
        if (!tree) return;
        var fileCount = 0;
        var langs = {};
        function count(node) {
            if (node.type === 'file') {
                fileCount++;
                var ext = node.name.split('.').pop();
                if (ext) langs[ext] = true;
            }
            if (node.children) node.children.forEach(count);
        }
        count(tree);
        var el = document.getElementById('header-stats');
        if (el) el.textContent = fileCount + ' files \u00b7 ' + Object.keys(langs).length + ' lang';

        var changedCount = 0;
        function countChanged(node) {
            if (node.type === 'file' && (node.status === 'modified' || node.status === 'new')) changedCount++;
            if (node.children) node.children.forEach(countChanged);
        }
        countChanged(tree);

        var sessionEl = document.getElementById('header-session');
        var countEl = document.getElementById('header-session-count');
        if (sessionEl && countEl) {
            if (changedCount > 0) {
                sessionEl.classList.remove('hidden');
                countEl.textContent = changedCount + ' changed';
            } else {
                sessionEl.classList.add('hidden');
            }
        }
    }

    // ── Tree ──
    function collectFiles(node, files) {
        if (node.type === 'file') files.push(node);
        if (node.children) node.children.forEach(function(c) { collectFiles(c, files); });
    }

    function renderTree(data) {
        if (!data) return;
        var root = document.getElementById('tree-root');
        var loading = document.getElementById('tree-loading');
        if (loading) loading.classList.add('hidden');
        if (!root) return;

        allFiles = [];
        collectFiles(data, allFiles);

        root.innerHTML = '';
        if (data.children) {
            data.children.forEach(function(child) { renderTreeNode(child, root, 0); });
        }
    }

    function renderTreeNode(node, parent, depth) {
        var el = document.createElement('div');
        el.className = 'tree-node ' + node.type + (selectedFile === node.path ? ' selected' : '');
        el.setAttribute('data-path', node.path);

        // Indent
        var indent = document.createElement('span');
        indent.className = 'tree-indent';
        indent.style.width = (depth * 16 + 8) + 'px';
        el.appendChild(indent);

        // Toggle
        var toggle = document.createElement('span');
        if (node.type === 'dir') {
            var isOpen = expandedDirs[node.path];
            toggle.className = 'tree-toggle ' + (isOpen ? 'is-open' : 'is-closed');
        } else {
            toggle.className = 'tree-toggle leaf';
        }
        el.appendChild(toggle);

        // Status dot
        var statusDot = document.createElement('span');
        if (node.type === 'file' && node.status) {
            statusDot.className = 'tree-status-dot status-' + node.status;
        } else {
            statusDot.className = 'tree-status-dot no-dot';
        }
        el.appendChild(statusDot);

        // Git dot
        if (node.type === 'file' && node.gitStatus) {
            var gitDot = document.createElement('span');
            gitDot.className = 'tree-git-dot git-' + node.gitStatus;
            gitDot.title = node.gitStatus;
            el.appendChild(gitDot);
        }

        // Label
        var label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = node.name;
        el.appendChild(label);

        // Stats badges
        if (node.type === 'file' && node.stats && (node.stats.methods > 0 || node.stats.types > 0)) {
            var badgeWrap = document.createElement('span');
            badgeWrap.className = 'tree-badges';
            if (node.stats.methods > 0) {
                var mb = document.createElement('span');
                mb.className = 'tree-badge tree-badge-m';
                mb.textContent = node.stats.methods + 'm';
                mb.title = node.stats.methods + (node.stats.methods === 1 ? ' method' : ' methods');
                badgeWrap.appendChild(mb);
            }
            if (node.stats.types > 0) {
                var tb = document.createElement('span');
                tb.className = 'tree-badge tree-badge-t';
                tb.textContent = node.stats.types + 't';
                tb.title = node.stats.types + (node.stats.types === 1 ? ' type' : ' types');
                badgeWrap.appendChild(tb);
            }
            el.appendChild(badgeWrap);
        }

        el.addEventListener('click', function(e) {
            e.stopPropagation();
            if (node.type === 'dir') {
                if (expandedDirs[node.path]) {
                    delete expandedDirs[node.path];
                } else {
                    expandedDirs[node.path] = true;
                }
                renderTree(treeData);
            } else {
                selectFile(node.path);
            }
        });

        parent.appendChild(el);

        // Children
        if (node.type === 'dir' && node.children) {
            var childContainer = document.createElement('div');
            childContainer.className = 'tree-children' + (expandedDirs[node.path] ? '' : ' collapsed');
            node.children.forEach(function(child) { renderTreeNode(child, childContainer, depth + 1); });
            parent.appendChild(childContainer);
        }
    }

    function selectFile(filePath) {
        selectedFile = filePath;

        // Update tree selection
        document.querySelectorAll('.tree-node.selected').forEach(function(n) { n.classList.remove('selected'); });
        var sel = document.querySelector('.tree-node[data-path="' + filePath.replace(/"/g, '\\\\"') + '"]');
        if (sel) sel.classList.add('selected');

        // Update tab bar context
        var ctxWrap = document.getElementById('tab-bar-file-context');
        var ctxDir = document.getElementById('ctx-file-dir');
        var ctxName = document.getElementById('ctx-file-name');
        if (ctxWrap && ctxDir && ctxName) {
            var fp = filePath.split('/');
            var fn = fp.pop();
            ctxDir.textContent = fp.join('/');
            ctxName.textContent = fn;
            ctxWrap.classList.remove('hidden');
        }

        // Show file header bar
        var headerBar = document.getElementById('file-header-bar');
        var breadcrumb = document.getElementById('file-breadcrumb');
        if (headerBar && breadcrumb) {
            var parts = filePath.split('/');
            var fileName = parts.pop();
            var dir = parts.join('/');
            breadcrumb.innerHTML = '';
            if (dir) {
                var dirSpan = document.createElement('span');
                dirSpan.className = 'breadcrumb-dir';
                dirSpan.textContent = dir;
                breadcrumb.appendChild(dirSpan);
                var sep = document.createElement('span');
                sep.className = 'breadcrumb-sep';
                sep.textContent = '/';
                breadcrumb.appendChild(sep);
            }
            var fileSpan = document.createElement('span');
            fileSpan.className = 'breadcrumb-file';
            fileSpan.textContent = fileName;
            breadcrumb.appendChild(fileSpan);
            headerBar.classList.remove('hidden');
        }

        // Clear previous content and show loading state
        var sigContent = document.getElementById('sig-content');
        var sigEmpty = document.getElementById('sig-empty-state');
        if (sigContent) sigContent.classList.add('hidden');
        if (sigEmpty) {
            sigEmpty.querySelector('.empty-state-label').textContent = 'Loading...';
            sigEmpty.classList.remove('hidden');
        }
        var srcContainer = document.getElementById('src-code-container');
        var srcEmpty = document.getElementById('src-empty-state');
        if (srcContainer) srcContainer.classList.add('hidden');
        if (srcEmpty) {
            srcEmpty.querySelector('.empty-state-label').textContent = 'Loading...';
            srcEmpty.classList.remove('hidden');
        }

        // Switch to signatures tab when file selected
        switchTab('signatures');

        // Request data
        send({ type: 'getSignature', file: filePath });
        send({ type: 'getFileContent', file: filePath });
    }

    // ── Signature ──
    function renderSignature(data, filePath) {
        var emptyState = document.getElementById('sig-empty-state');
        var content = document.getElementById('sig-content');
        if (!content || !emptyState) return;

        if (data.error) {
            emptyState.querySelector('.empty-state-label').textContent = data.error;
            emptyState.classList.remove('hidden');
            content.classList.add('hidden');
            return;
        }

        emptyState.classList.add('hidden');
        content.classList.remove('hidden');

        // Header
        var headerSection = document.getElementById('sig-header-section');
        var headerComment = document.getElementById('sig-header-comment');
        if (headerSection && headerComment) {
            if (data.header) {
                headerComment.textContent = data.header;
                headerSection.classList.remove('hidden');
            } else {
                headerSection.classList.add('hidden');
            }
        }

        // Types
        var typesSection = document.getElementById('sig-types-section');
        var typeList = document.getElementById('sig-type-list');
        if (typesSection && typeList) {
            typeList.innerHTML = '';
            if (data.types && data.types.length > 0) {
                data.types.forEach(function(t) {
                    var li = document.createElement('li');
                    li.className = 'sig-type-item';
                    li.innerHTML = '<span class="sig-type-line">' + t.line + '</span>' +
                        '<span class="sig-type-kind">' + esc(t.kind) + '</span>' +
                        '<span class="sig-type-name">' + esc(t.name) + '</span>';
                    li.style.cursor = 'pointer';
                    li.addEventListener('click', function() {
                        switchTab('source');
                        setTimeout(function() { scrollToLine(t.line); }, 100);
                    });
                    typeList.appendChild(li);
                });
                typesSection.classList.remove('hidden');
            } else {
                typesSection.classList.add('hidden');
            }
        }

        // Methods
        var methodsSection = document.getElementById('sig-methods-section');
        var methodList = document.getElementById('sig-method-list');
        if (methodsSection && methodList) {
            methodList.innerHTML = '';
            if (data.methods && data.methods.length > 0) {
                data.methods.forEach(function(m) {
                    var li = document.createElement('li');
                    li.className = 'sig-method-item';
                    var html = '<span class="sig-method-line">' + m.line + '</span>';
                    if (m.visibility && m.visibility !== 'public') {
                        html += '<span class="sig-method-visibility">' + esc(m.visibility) + '</span>';
                    }
                    if (m.static) html += '<span class="sig-method-modifier">static</span>';
                    if (m.async) html += '<span class="sig-method-modifier">async</span>';
                    html += '<span class="sig-method-proto">' + esc(m.prototype) + '</span>';
                    li.innerHTML = html;
                    li.style.cursor = 'pointer';
                    li.addEventListener('click', function() {
                        switchTab('source');
                        setTimeout(function() { scrollToLine(m.line); }, 100);
                    });
                    methodList.appendChild(li);
                });
                methodsSection.classList.remove('hidden');
            } else {
                methodsSection.classList.add('hidden');
            }
        }

        // Empty state: no header, no types, no methods
        var hasContent = (data.header) ||
            (data.types && data.types.length > 0) ||
            (data.methods && data.methods.length > 0);
        if (!hasContent) {
            emptyState.querySelector('.empty-state-label').textContent = 'No signatures found for this file';
            emptyState.classList.remove('hidden');
            content.classList.add('hidden');
        }

        // Stat pills
        var pills = document.getElementById('file-stat-pills');
        if (pills) {
            pills.innerHTML = '';
            if (data.methods && data.methods.length > 0) {
                var mp = document.createElement('span');
                mp.className = 'file-stat-pill methods';
                mp.textContent = data.methods.length + 'm';
                pills.appendChild(mp);
            }
            if (data.types && data.types.length > 0) {
                var tp = document.createElement('span');
                tp.className = 'file-stat-pill types';
                tp.textContent = data.types.length + 't';
                pills.appendChild(tp);
            }
        }
    }

    // ── Source ──
    function renderSource(data, filePath) {
        var emptyState = document.getElementById('src-empty-state');
        var container = document.getElementById('src-code-container');
        var codeBlock = document.getElementById('src-code-block');
        if (!container || !codeBlock || !emptyState) return;

        if (data.error) {
            emptyState.querySelector('.empty-state-label').textContent = data.error;
            emptyState.classList.remove('hidden');
            container.classList.add('hidden');
            return;
        }

        emptyState.classList.add('hidden');
        container.classList.remove('hidden');
        codeBlock.textContent = data.content;
        codeBlock.removeAttribute('data-highlighted');
        codeBlock.className = '';
        if (data.language && data.language !== 'plaintext') {
            codeBlock.className = 'language-' + data.language;
        }
        hljs.highlightElement(codeBlock);

        // Generate line numbers
        var lineNums = document.getElementById('src-line-numbers');
        if (lineNums) {
            var lineCount = (data.content || '').split('\\n').length;
            var html = '';
            for (var i = 1; i <= lineCount; i++) {
                html += '<span>' + i + '</span>';
            }
            lineNums.innerHTML = html;
        }
    }

    function scrollToLine(lineNumber) {
        var codeBlock = document.getElementById('src-code-block');
        if (!codeBlock) return;
        var lineHeight = 19.5;
        var scrollTop = (lineNumber - 1) * lineHeight - 100;
        var container = document.getElementById('src-code-container');
        if (container) container.scrollTop = Math.max(0, scrollTop);
    }

    // ── Tasks ──
    function renderTaskItemHtml(task) {
        var html = '<div class="task-item-header">';
        html += '<span class="task-title" data-task-id="' + task.id + '" data-field="title">' + esc(task.title) + '</span>';
        html += '<span class="task-status-badge status-' + task.status + '">' + statusLabel(task.status) + '</span>';
        html += '</div>';

        if (task.description) {
            html += '<div class="task-description">' + esc(task.description) + '</div>';
        }

        html += '<div class="task-meta-row"><div class="task-tags-editable" data-task-id="' + task.id + '" data-field="tags" data-tags="' + esc(task.tags || '') + '">';
        if (task.tags) {
            task.tags.split(',').forEach(function(tag) {
                tag = tag.trim();
                if (tag) html += '<span class="task-tag">' + esc(tag) + '</span>';
            });
        } else {
            html += '<span style="font-size:10px;color:var(--text-muted);opacity:0.6">+ tags</span>';
        }
        html += '</div></div>';

        html += '<div class="task-actions">';
        if (task.status === 'backlog') {
            html += '<button class="task-btn btn-start" data-task-id="' + task.id + '" data-action="active">Start</button>';
            html += '<button class="task-btn btn-done" data-task-id="' + task.id + '" data-action="done">Done</button>';
            html += '<button class="task-btn btn-cancel" data-task-id="' + task.id + '" data-action="cancelled">Cancel</button>';
        } else if (task.status === 'active') {
            html += '<button class="task-btn btn-done" data-task-id="' + task.id + '" data-action="done">Done</button>';
            html += '<button class="task-btn btn-backlog" data-task-id="' + task.id + '" data-action="backlog">Backlog</button>';
            html += '<button class="task-btn btn-cancel" data-task-id="' + task.id + '" data-action="cancelled">Cancel</button>';
        } else if (task.status === 'done') {
            html += '<button class="task-btn btn-reopen" data-task-id="' + task.id + '" data-action="active">Reopen</button>';
            html += '<button class="task-btn btn-backlog" data-task-id="' + task.id + '" data-action="backlog">Backlog</button>';
        } else if (task.status === 'cancelled') {
            html += '<button class="task-btn btn-reopen" data-task-id="' + task.id + '" data-action="active">Reopen</button>';
            html += '<button class="task-btn btn-backlog" data-task-id="' + task.id + '" data-action="backlog">Backlog</button>';
        }
        html += '</div>';

        return html;
    }

    function applyTaskFilters(tasks) {
        var filtered = tasks;
        if (currentTagFilters.length > 0) {
            filtered = filtered.filter(function(t) {
                if (!t.tags) return false;
                var taskTags = t.tags.split(',').map(function(tag) { return tag.trim().toLowerCase(); });
                return currentTagFilters.every(function(f) {
                    return taskTags.indexOf(f.toLowerCase()) !== -1;
                });
            });
        }
        if (currentStatusFilters.length > 0) {
            filtered = filtered.filter(function(t) {
                return currentStatusFilters.indexOf(t.status) !== -1;
            });
        }
        return filtered;
    }

    function getAllTags(tasks) {
        var tagCounts = {};
        tasks.forEach(function(t) {
            if (t.tags) {
                t.tags.split(',').forEach(function(tag) {
                    tag = tag.trim();
                    if (tag) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                });
            }
        });
        return tagCounts;
    }

    function updateFilterUI() {
        var trigger = document.getElementById('tasks-filter-trigger');
        var pillBar = document.getElementById('tasks-active-filters');
        if (!trigger || !pillBar) return;

        var totalFilters = currentTagFilters.length + currentStatusFilters.length;
        if (totalFilters > 0) {
            trigger.classList.add('has-filters');
            trigger.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg> Filter <span class="filter-count">' + totalFilters + '</span>';
        } else {
            trigger.classList.remove('has-filters');
            trigger.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg> Filter';
        }

        // Active filter pills
        if (totalFilters > 0) {
            var html = '';
            currentTagFilters.forEach(function(tag) {
                html += '<span class="active-filter-pill" data-filter-type="tag" data-filter-value="' + esc(tag) + '">' + esc(tag) + ' <span class="pill-x">&times;</span></span>';
            });
            currentStatusFilters.forEach(function(st) {
                html += '<span class="active-filter-pill" data-filter-type="status" data-filter-value="' + st + '">' + statusLabel(st) + ' <span class="pill-x">&times;</span></span>';
            });
            pillBar.innerHTML = html;
            pillBar.classList.add('visible');
        } else {
            pillBar.innerHTML = '';
            pillBar.classList.remove('visible');
        }
    }

    function buildFilterDropdown() {
        var dropdown = document.getElementById('tasks-filter-dropdown');
        if (!dropdown || !currentTasksData) return;

        var tagCounts = getAllTags(currentTasksData);
        var tagNames = Object.keys(tagCounts).sort();

        var statusCounts = {};
        currentTasksData.forEach(function(t) {
            statusCounts[t.status] = (statusCounts[t.status] || 0) + 1;
        });
        var statuses = ['active', 'backlog', 'done', 'cancelled'].filter(function(s) { return statusCounts[s]; });

        var html = '';

        // Tags section
        if (tagNames.length > 0) {
            html += '<div class="filter-dropdown-label">Tags</div>';
            tagNames.forEach(function(tag) {
                var selected = currentTagFilters.indexOf(tag) !== -1;
                html += '<div class="filter-dropdown-item' + (selected ? ' selected' : '') + '" data-filter-type="tag" data-filter-value="' + esc(tag) + '">';
                html += '<span class="filter-check">' + (selected ? '&#10003;' : '') + '</span>';
                html += '<span class="filter-tag-name">' + esc(tag) + '</span>';
                html += '<span class="filter-tag-count">' + tagCounts[tag] + '</span>';
                html += '</div>';
            });
        }

        // Status section
        if (statuses.length > 0) {
            if (tagNames.length > 0) html += '<div class="filter-dropdown-divider"></div>';
            html += '<div class="filter-dropdown-label">Status</div>';
            statuses.forEach(function(st) {
                var selected = currentStatusFilters.indexOf(st) !== -1;
                html += '<div class="filter-dropdown-item' + (selected ? ' selected' : '') + '" data-filter-type="status" data-filter-value="' + st + '">';
                html += '<span class="filter-check">' + (selected ? '&#10003;' : '') + '</span>';
                html += '<span class="filter-tag-name">' + statusLabel(st) + '</span>';
                html += '<span class="filter-tag-count">' + statusCounts[st] + '</span>';
                html += '</div>';
            });
        }

        // Clear all
        if (currentTagFilters.length + currentStatusFilters.length > 0) {
            html += '<div class="filter-dropdown-divider"></div>';
            html += '<div class="filter-dropdown-clear" id="filter-clear-all">Clear all filters</div>';
        }

        if (!tagNames.length && !statuses.length) {
            html += '<div class="filter-dropdown-label" style="padding:12px 8px;text-align:center">No tags or tasks yet</div>';
        }

        dropdown.innerHTML = html;
    }

    function renderTasks(tasks) {
        if (!tasks) return;
        currentTasksData = tasks;

        var badge = document.getElementById('tasks-badge');
        if (badge) {
            var activeCount = tasks.filter(function(t) { return t.status === 'active' || t.status === 'backlog'; }).length;
            badge.textContent = activeCount;
        }

        var filtered = applyTaskFilters(tasks);
        updateFilterUI();

        var emptyState = document.getElementById('tasks-empty-state');
        if (emptyState) {
            if (tasks.length > 0) emptyState.classList.add('hidden');
            else emptyState.classList.remove('hidden');
        }

        if (currentTaskGroup === 'tag') {
            hideStatusSections();
            renderTasksByTag(filtered);
        } else {
            hideTagView();
            renderStatusSections(filtered);
        }
    }

    function renderStatusSections(tasks) {
        var activeTasks = tasks.filter(function(t) { return t.status === 'active'; });
        var backlogTasks = tasks.filter(function(t) { return t.status === 'backlog'; });
        var doneTasks = tasks.filter(function(t) { return t.status === 'done'; });
        var cancelledTasks = tasks.filter(function(t) { return t.status === 'cancelled'; });

        renderTaskSection('tasks-active-section', 'tasks-active-list', activeTasks);
        renderTaskSection('tasks-backlog-section', 'tasks-backlog-list', backlogTasks);
        renderTaskSection('tasks-done-section', 'tasks-done-list', doneTasks);
        renderTaskSection('tasks-cancelled-section', 'tasks-cancelled-list', cancelledTasks);
    }

    function hideStatusSections() {
        ['tasks-active-section', 'tasks-backlog-section', 'tasks-done-section', 'tasks-cancelled-section'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
    }

    function hideTagView() {
        var tagView = document.getElementById('tasks-tag-view');
        if (tagView) {
            tagView.classList.add('hidden');
            tagView.innerHTML = '';
        }
    }

    function renderTasksByTag(tasks) {
        var tagView = document.getElementById('tasks-tag-view');
        if (!tagView) return;

        tagView.innerHTML = '';
        tagView.classList.remove('hidden');

        var tagMap = {};
        tasks.forEach(function(task) {
            if (task.tags) {
                task.tags.split(',').forEach(function(tag) {
                    tag = tag.trim();
                    if (tag) {
                        if (!tagMap[tag]) tagMap[tag] = [];
                        tagMap[tag].push(task);
                    }
                });
            } else {
                if (!tagMap['Untagged']) tagMap['Untagged'] = [];
                tagMap['Untagged'].push(task);
            }
        });

        var tagNames = Object.keys(tagMap).sort(function(a, b) {
            if (a === 'Untagged') return 1;
            if (b === 'Untagged') return -1;
            return a.localeCompare(b);
        });

        tagNames.forEach(function(tagName) {
            var section = document.createElement('div');
            section.className = 'task-tag-section';

            var header = document.createElement('div');
            header.className = 'task-section-label';
            header.innerHTML = esc(tagName) + ' <span style="opacity:0.5">(' + tagMap[tagName].length + ')</span>';

            var list = document.createElement('ul');
            list.className = 'task-list';

            tagMap[tagName].forEach(function(task) {
                var li = document.createElement('li');
                li.className = 'task-item priority-' + task.priority + ' status-' + task.status;
                li.setAttribute('draggable', 'true');
                li.setAttribute('data-task-id', task.id);
                li.innerHTML = renderTaskItemHtml(task);
                list.appendChild(li);
            });

            section.appendChild(header);
            section.appendChild(list);
            tagView.appendChild(section);
        });
    }

    function renderTaskSection(sectionId, listId, tasks) {
        var section = document.getElementById(sectionId);
        var list = document.getElementById(listId);
        if (!section || !list) return;

        if (tasks.length === 0) {
            section.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');
        list.innerHTML = '';

        tasks.forEach(function(task) {
            var li = document.createElement('li');
            li.className = 'task-item priority-' + task.priority + ' status-' + task.status;
            li.setAttribute('draggable', 'true');
            li.setAttribute('data-task-id', task.id);
            li.innerHTML = renderTaskItemHtml(task);
            list.appendChild(li);
        });
    }

    // ── Task Create Form ──
    function initTaskCreateForm() {
        var tasksView = document.getElementById('tasks-view');
        if (!tasksView) return;

        var formWrap = document.createElement('div');
        formWrap.id = 'task-create-form';
        formWrap.style.cssText = 'margin-bottom: 16px;';

        var toggleBtn = document.createElement('button');
        toggleBtn.id = 'task-create-toggle';
        toggleBtn.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:4px;border:1px dashed var(--border);background:transparent;color:var(--text-muted);font-size:11px;font-family:IBM Plex Sans,sans-serif;cursor:pointer;width:100%;transition:border-color 0.15s,color 0.15s;letter-spacing:0.03em';
        toggleBtn.innerHTML = '<span style="font-size:14px;line-height:1">+</span> New task';

        var fields = document.createElement('div');
        fields.id = 'task-create-fields';
        fields.className = 'hidden';
        fields.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border);border-radius:4px;padding:12px;display:flex;flex-direction:column;gap:8px';
        fields.innerHTML = '<input type="text" id="task-title-input" placeholder="Task title..." style="background:var(--bg-primary);border:1px solid var(--border);border-radius:3px;padding:6px 10px;color:var(--text-primary);font-size:12px;font-family:IBM Plex Sans,sans-serif;outline:none;width:100%" />'
            + '<div style="display:flex;gap:8px;align-items:center">'
            + '<label style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em">Priority</label>'
            + '<select id="task-priority-select" style="background:var(--bg-primary);border:1px solid var(--border);border-radius:3px;padding:3px 8px;color:var(--text-primary);font-size:11px;font-family:IBM Plex Sans,sans-serif">'
            + '<option value="1">High</option><option value="2" selected>Medium</option><option value="3">Low</option></select>'
            + '<label style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-left:8px">Tags</label>'
            + '<input type="text" id="task-tags-input" placeholder="bug, fix" style="background:var(--bg-primary);border:1px solid var(--border);border-radius:3px;padding:3px 8px;color:var(--text-primary);font-size:11px;font-family:IBM Plex Sans,sans-serif;flex:1;outline:none" /></div>'
            + '<div style="display:flex;gap:6px;justify-content:flex-end">'
            + '<button id="task-create-cancel" style="padding:4px 12px;border-radius:3px;border:1px solid var(--border);background:transparent;color:var(--text-muted);font-size:11px;font-family:IBM Plex Sans,sans-serif;cursor:pointer">Cancel</button>'
            + '<button id="task-create-submit" style="padding:4px 12px;border-radius:3px;border:1px solid var(--accent);background:var(--accent);color:#fff;font-size:11px;font-family:IBM Plex Sans,sans-serif;cursor:pointer;font-weight:500">Create</button></div>'
            + '<div style="font-size:10px;color:var(--text-muted);opacity:0.7">Tip: You can also create tasks via chronicle_task MCP tool</div>';

        formWrap.appendChild(toggleBtn);
        formWrap.appendChild(fields);

        var filterBar = document.getElementById('tasks-filter-bar');
        if (filterBar) {
            tasksView.insertBefore(formWrap, filterBar);
        } else {
            tasksView.insertBefore(formWrap, tasksView.firstChild);
        }

        toggleBtn.addEventListener('click', function() {
            toggleBtn.classList.add('hidden');
            fields.classList.remove('hidden');
            document.getElementById('task-title-input').focus();
        });

        document.getElementById('task-create-cancel').addEventListener('click', function() {
            fields.classList.add('hidden');
            toggleBtn.classList.remove('hidden');
            document.getElementById('task-title-input').value = '';
            document.getElementById('task-tags-input').value = '';
        });

        document.getElementById('task-create-submit').addEventListener('click', submitTask);

        document.getElementById('task-title-input').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') submitTask();
            if (e.key === 'Escape') {
                fields.classList.add('hidden');
                toggleBtn.classList.remove('hidden');
            }
        });
    }

    function submitTask() {
        var titleInput = document.getElementById('task-title-input');
        var title = titleInput.value.trim();
        if (!title) return;

        var priority = parseInt(document.getElementById('task-priority-select').value);
        var tags = document.getElementById('task-tags-input').value.trim();

        send({ type: 'createTask', title: title, priority: priority, tags: tags });

        titleInput.value = '';
        document.getElementById('task-tags-input').value = '';
        document.getElementById('task-create-fields').classList.add('hidden');
        document.getElementById('task-create-toggle').classList.remove('hidden');
    }

    // ── Tabs ──
    function switchTab(tabName) {
        currentTab = tabName;
        document.querySelectorAll('.detail-tab').forEach(function(tab) {
            var isActive = tab.getAttribute('data-detail-tab') === tabName;
            tab.classList.toggle('active', isActive);
            tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        document.querySelectorAll('.detail-view').forEach(function(view) {
            view.classList.remove('active');
        });
        var viewId = tabName === 'signatures' ? 'signature-view' :
                     tabName === 'source' ? 'source-view' : 'tasks-view';
        var targetView = document.getElementById(viewId);
        if (targetView) targetView.classList.add('active');
    }

    function initTabs() {
        document.querySelectorAll('.detail-tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                switchTab(tab.getAttribute('data-detail-tab'));
            });
        });
    }

    // ── Command Palette ──
    function initCommandPalette() {
        var overlay = document.getElementById('cmd-palette-overlay');
        var input = document.getElementById('cmd-palette-input');
        var results = document.getElementById('cmd-palette-results');
        var trigger = document.getElementById('cmd-palette-trigger');
        var emptyState = document.getElementById('cmd-palette-empty');
        var focusedIndex = -1;
        var resultItems = [];

        function open() {
            overlay.classList.remove('hidden');
            input.value = '';
            input.focus();
            renderResults('');
            focusedIndex = -1;
        }

        function close() {
            overlay.classList.add('hidden');
            input.value = '';
        }

        function renderResults(query) {
            results.querySelectorAll('.cmd-result-section-label, .cmd-result-item').forEach(function(el) { el.remove(); });
            resultItems = [];

            if (!query) {
                if (emptyState) emptyState.classList.add('hidden');
                var label = document.createElement('div');
                label.className = 'cmd-result-section-label';
                label.textContent = 'Files';
                results.insertBefore(label, emptyState);
                allFiles.slice(0, 20).forEach(function(file, i) {
                    var item = createResultItem(file, i);
                    results.insertBefore(item, emptyState);
                    resultItems.push(item);
                });
                return;
            }

            var q = query.toLowerCase();
            var scored = allFiles.map(function(file) {
                var name = file.name.toLowerCase();
                var path = file.path.toLowerCase();
                var score = 0;
                if (name === q) score = 100;
                else if (name.startsWith(q)) score = 80;
                else if (name.includes(q)) score = 60;
                else if (path.includes(q)) score = 40;
                return { file: file, score: score };
            }).filter(function(s) { return s.score > 0; })
              .sort(function(a, b) { return b.score - a.score; })
              .slice(0, 20);

            if (scored.length === 0) {
                if (emptyState) emptyState.classList.remove('hidden');
                return;
            }
            if (emptyState) emptyState.classList.add('hidden');

            var lbl = document.createElement('div');
            lbl.className = 'cmd-result-section-label';
            lbl.textContent = 'Files';
            results.insertBefore(lbl, emptyState);

            scored.forEach(function(s, i) {
                var item = createResultItem(s.file, i);
                results.insertBefore(item, emptyState);
                resultItems.push(item);
            });
            focusedIndex = 0;
            updateFocus();
        }

        function createResultItem(file, index) {
            var item = document.createElement('div');
            item.className = 'cmd-result-item';
            item.setAttribute('data-index', index);
            item.innerHTML = '<span class="cmd-result-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/></svg></span>'
                + '<span class="cmd-result-name">' + esc(file.name) + '</span>'
                + '<span class="cmd-result-path">' + esc(file.path) + '</span>';
            item.addEventListener('click', function() {
                selectFile(file.path);
                close();
            });
            return item;
        }

        function updateFocus() {
            resultItems.forEach(function(item, i) {
                item.classList.toggle('focused', i === focusedIndex);
            });
            if (focusedIndex >= 0 && resultItems[focusedIndex]) {
                resultItems[focusedIndex].scrollIntoView({ block: 'nearest' });
            }
        }

        trigger.addEventListener('click', open);

        document.addEventListener('keydown', function(e) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                if (overlay.classList.contains('hidden')) open();
                else close();
            }
            if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
                close();
            }
        });

        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) close();
        });

        input.addEventListener('input', function() {
            renderResults(input.value.trim());
        });

        input.addEventListener('keydown', function(e) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (focusedIndex < resultItems.length - 1) { focusedIndex++; updateFocus(); }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (focusedIndex > 0) { focusedIndex--; updateFocus(); }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (focusedIndex >= 0 && resultItems[focusedIndex]) { resultItems[focusedIndex].click(); }
            }
        });
    }

    // ── Splitter ──
    function initSplitter() {
        var splitter = document.getElementById('splitter');
        var treePanel = document.getElementById('tree-panel');
        if (!splitter || !treePanel) return;

        var isDragging = false;
        splitter.addEventListener('mousedown', function(e) {
            isDragging = true;
            splitter.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', function(e) {
            if (!isDragging) return;
            var newWidth = Math.min(Math.max(e.clientX, 160), window.innerWidth * 0.5);
            treePanel.style.width = newWidth + 'px';
        });

        document.addEventListener('mouseup', function() {
            if (!isDragging) return;
            isDragging = false;
            splitter.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        });
    }

    // ── Theme ──
    function initTheme() {
        var gearBtn = document.getElementById('theme-gear-btn');
        var panel = document.getElementById('theme-panel');
        if (!gearBtn || !panel) return;

        var current = localStorage.getItem('chronicle-theme') || 'observatory';
        document.documentElement.setAttribute('data-theme', current);

        function updateActive() {
            panel.querySelectorAll('.theme-btn').forEach(function(btn) {
                btn.classList.toggle('active', btn.getAttribute('data-theme-value') === current);
            });
        }
        updateActive();

        panel.querySelectorAll('.theme-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                current = btn.getAttribute('data-theme-value');
                document.documentElement.setAttribute('data-theme', current);
                localStorage.setItem('chronicle-theme', current);
                updateActive();
                panel.classList.remove('open');
            });
        });

        gearBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            panel.classList.toggle('open');
        });

        document.addEventListener('click', function(e) {
            if (!document.getElementById('theme-switcher').contains(e.target)) {
                panel.classList.remove('open');
            }
        });
    }

    // ── Tree Filters ──
    function initTreeFilters() {
        document.querySelectorAll('.tree-filter-pill').forEach(function(pill) {
            pill.addEventListener('click', function() {
                var mode = pill.getAttribute('data-tree-mode');
                currentTreeMode = mode;

                document.querySelectorAll('.tree-filter-pill').forEach(function(p) {
                    p.classList.toggle('active', p.getAttribute('data-tree-mode') === mode);
                    p.setAttribute('aria-pressed', p.getAttribute('data-tree-mode') === mode ? 'true' : 'false');
                });

                if (mode === 'code' && codeTreeData) {
                    treeData = codeTreeData;
                    renderTree(treeData);
                } else if (mode === 'all' && allTreeData) {
                    treeData = allTreeData;
                    renderTree(treeData);
                } else {
                    send({ type: 'getTree', mode: mode });
                }
            });
        });
    }

    // ── Task Actions (delegated) ──
    function initTaskActions() {
        document.getElementById('tasks-view').addEventListener('click', function(e) {
            var btn = e.target.closest('.task-btn');
            if (!btn) return;
            var taskId = parseInt(btn.getAttribute('data-task-id'));
            var action = btn.getAttribute('data-action');
            if (taskId && action) {
                send({ type: 'updateTaskStatus', taskId: taskId, status: action });
            }
        });

        var doneToggle = document.getElementById('task-done-toggle');
        var doneWrap = document.getElementById('tasks-done-list-wrap');
        if (doneToggle && doneWrap) {
            doneToggle.addEventListener('click', function() {
                doneToggle.classList.toggle('open');
                doneWrap.classList.toggle('collapsed');
            });
        }

        var cancelledToggle = document.getElementById('task-cancelled-toggle');
        var cancelledWrap = document.getElementById('tasks-cancelled-list-wrap');
        if (cancelledToggle && cancelledWrap) {
            cancelledToggle.addEventListener('click', function() {
                cancelledToggle.classList.toggle('open');
                cancelledWrap.classList.toggle('collapsed');
            });
        }
    }

    // ── Task Group Toggle ──
    function initTaskFiltering() {
        var trigger = document.getElementById('tasks-filter-trigger');
        var dropdown = document.getElementById('tasks-filter-dropdown');
        if (!trigger || !dropdown) return;

        // Toggle dropdown
        trigger.addEventListener('click', function(e) {
            e.stopPropagation();
            var isOpen = dropdown.classList.contains('open');
            if (isOpen) {
                dropdown.classList.remove('open');
            } else {
                buildFilterDropdown();
                dropdown.classList.add('open');
            }
        });

        // Dropdown item clicks
        dropdown.addEventListener('click', function(e) {
            e.stopPropagation();
            var item = e.target.closest('.filter-dropdown-item');
            if (item) {
                var type = item.getAttribute('data-filter-type');
                var value = item.getAttribute('data-filter-value');
                if (type === 'tag') {
                    var idx = currentTagFilters.indexOf(value);
                    if (idx !== -1) currentTagFilters.splice(idx, 1);
                    else currentTagFilters.push(value);
                } else if (type === 'status') {
                    var idx2 = currentStatusFilters.indexOf(value);
                    if (idx2 !== -1) currentStatusFilters.splice(idx2, 1);
                    else currentStatusFilters.push(value);
                }
                buildFilterDropdown();
                updateFilterUI();
                if (currentTasksData) renderTasks(currentTasksData);
                return;
            }
            var clearAll = e.target.closest('.filter-dropdown-clear');
            if (clearAll) {
                currentTagFilters = [];
                currentStatusFilters = [];
                dropdown.classList.remove('open');
                updateFilterUI();
                if (currentTasksData) renderTasks(currentTasksData);
            }
        });

        // Close dropdown on outside click
        document.addEventListener('click', function() {
            dropdown.classList.remove('open');
        });

        // Active filter pill removal
        document.getElementById('tasks-active-filters').addEventListener('click', function(e) {
            var pill = e.target.closest('.active-filter-pill');
            if (!pill) return;
            var type = pill.getAttribute('data-filter-type');
            var value = pill.getAttribute('data-filter-value');
            if (type === 'tag') {
                var idx = currentTagFilters.indexOf(value);
                if (idx !== -1) currentTagFilters.splice(idx, 1);
            } else if (type === 'status') {
                var idx2 = currentStatusFilters.indexOf(value);
                if (idx2 !== -1) currentStatusFilters.splice(idx2, 1);
            }
            updateFilterUI();
            if (currentTasksData) renderTasks(currentTasksData);
        });

        // Tag pill click on task items → quick filter
        document.getElementById('tasks-view').addEventListener('click', function(e) {
            var tagEl = e.target.closest('.task-tag');
            if (!tagEl) return;
            if (tagEl.closest('.task-tags-editable') && tagEl.closest('.task-tags-editable').querySelector('input')) return;
            var tagText = tagEl.textContent.trim();
            var idx = currentTagFilters.indexOf(tagText);
            if (idx !== -1) currentTagFilters.splice(idx, 1);
            else currentTagFilters.push(tagText);
            updateFilterUI();
            if (currentTasksData) renderTasks(currentTasksData);
        });
    }

    function initTaskGroupToggle() {
        document.querySelectorAll('.tasks-group-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var mode = btn.getAttribute('data-tasks-group');
                if (mode === currentTaskGroup) return;

                currentTaskGroup = mode;

                document.querySelectorAll('.tasks-group-btn').forEach(function(b) {
                    var isActive = b.getAttribute('data-tasks-group') === mode;
                    b.classList.toggle('active', isActive);
                    b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
                });

                if (currentTasksData) {
                    renderTasks(currentTasksData);
                }
            });
        });
    }

    // ── Task Inline Editing (delegated) ──
    function initTaskInlineEdit() {
        var tasksView = document.getElementById('tasks-view');
        if (!tasksView) return;

        tasksView.addEventListener('click', function(e) {
            // Title editing
            var titleEl = e.target.closest('.task-title[data-field="title"]');
            if (titleEl && !titleEl.querySelector('input')) {
                e.stopPropagation();
                var taskId = parseInt(titleEl.getAttribute('data-task-id'));
                var currentText = titleEl.textContent;
                var input = document.createElement('input');
                input.type = 'text';
                input.className = 'task-edit-input';
                input.value = currentText;
                titleEl.textContent = '';
                titleEl.appendChild(input);
                input.focus();
                input.select();

                function save() {
                    var newVal = input.value.trim();
                    if (newVal && newVal !== currentText) {
                        send({ type: 'updateTask', taskId: taskId, title: newVal });
                    } else {
                        titleEl.textContent = currentText;
                    }
                }
                input.addEventListener('blur', save);
                input.addEventListener('keydown', function(ev) {
                    if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
                    if (ev.key === 'Escape') { input.value = currentText; input.blur(); }
                });
                return;
            }

            // Tags editing — skip if clicking a tag pill (that triggers filter)
            if (e.target.closest('.task-tag')) return;
            var tagsEl = e.target.closest('.task-tags-editable[data-field="tags"]');
            if (tagsEl && !tagsEl.querySelector('input')) {
                e.stopPropagation();
                var taskId2 = parseInt(tagsEl.getAttribute('data-task-id'));
                var currentTags = tagsEl.getAttribute('data-tags') || '';
                var input2 = document.createElement('input');
                input2.type = 'text';
                input2.className = 'task-tags-input';
                input2.value = currentTags;
                input2.placeholder = 'tag1, tag2, ...';
                tagsEl.innerHTML = '';
                tagsEl.appendChild(input2);
                input2.focus();
                input2.select();

                function saveTags() {
                    var newVal = input2.value.trim();
                    if (newVal !== currentTags) {
                        send({ type: 'updateTask', taskId: taskId2, tags: newVal });
                    } else if (currentTasksData) {
                        renderTasks(currentTasksData);
                    }
                }
                input2.addEventListener('blur', saveTags);
                input2.addEventListener('keydown', function(ev) {
                    if (ev.key === 'Enter') { ev.preventDefault(); input2.blur(); }
                    if (ev.key === 'Escape') { input2.value = currentTags; input2.blur(); }
                });
                return;
            }
        });
    }

    // ── Task Drag & Drop (delegated) ──
    function initTaskDragDrop() {
        var tasksView = document.getElementById('tasks-view');
        if (!tasksView) return;

        var dragItem = null;

        tasksView.addEventListener('dragstart', function(e) {
            var item = e.target.closest('.task-item');
            if (!item) return;
            dragItem = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.getAttribute('data-task-id'));
        });

        tasksView.addEventListener('dragend', function(e) {
            var item = e.target.closest('.task-item');
            if (item) item.classList.remove('dragging');
            tasksView.querySelectorAll('.drag-over').forEach(function(el) {
                el.classList.remove('drag-over');
            });
            dragItem = null;
        });

        tasksView.addEventListener('dragover', function(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            var item = e.target.closest('.task-item');
            if (!item || item === dragItem) return;

            tasksView.querySelectorAll('.drag-over').forEach(function(el) {
                el.classList.remove('drag-over');
            });
            item.classList.add('drag-over');
        });

        tasksView.addEventListener('dragleave', function(e) {
            var item = e.target.closest('.task-item');
            if (item) item.classList.remove('drag-over');
        });

        tasksView.addEventListener('drop', function(e) {
            e.preventDefault();
            var dropTarget = e.target.closest('.task-item');
            if (!dropTarget || !dragItem || dropTarget === dragItem) return;

            // Only reorder within same list
            var sourceList = dragItem.closest('.task-list');
            var targetList = dropTarget.closest('.task-list');
            if (!sourceList || sourceList !== targetList) return;

            // Move DOM element
            var items = Array.from(sourceList.children);
            var dragIdx = items.indexOf(dragItem);
            var dropIdx = items.indexOf(dropTarget);

            if (dragIdx < dropIdx) {
                sourceList.insertBefore(dragItem, dropTarget.nextSibling);
            } else {
                sourceList.insertBefore(dragItem, dropTarget);
            }

            // Collect new order and send to server
            var taskIds = Array.from(sourceList.children).map(function(li) {
                return parseInt(li.getAttribute('data-task-id'));
            }).filter(function(id) { return !isNaN(id); });

            send({ type: 'reorderTasks', taskIds: taskIds });

            tasksView.querySelectorAll('.drag-over').forEach(function(el) {
                el.classList.remove('drag-over');
            });
        });
    }

    // ── Init ──
    connect();
    initTabs();
    initTreeFilters();
    initSplitter();
    initTheme();
    initCommandPalette();
    initTaskCreateForm();
    initTaskActions();
    initTaskFiltering();
    initTaskGroupToggle();
    initTaskInlineEdit();
    initTaskDragDrop();

    // Request tree and tasks on load
    setTimeout(function() {
        send({ type: 'getTree', mode: currentTreeMode });
        send({ type: 'getTasks' });
    }, 200);
})();
