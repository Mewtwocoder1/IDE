import { createContainer } from 'https://esm.sh/almostnode@0.2.14';
import { openDB } from 'https://esm.sh/idb@8.0.0';

/**
 * 1. DYNAMIC SERVICE WORKER REGISTRATION
 */
if ('serviceWorker' in navigator) {
    const isGitHubPages = window.location.hostname.includes('github.io');
    const repoName = window.location.pathname.split('/')[1];
    const swPath = isGitHubPages ? `/${repoName}/sw.js` : './sw.js';

    navigator.serviceWorker.register(swPath, { type: 'module' })
        .then(reg => console.log("Service Worker Active:", reg.scope))
        .catch(err => console.error("SW Registration failed:", err));
}

/**
 * 2. DATABASE & CONTAINER SETUP
 */
const dbPromise = openDB('iPadIDE', 1, { 
    upgrade(db) { if (!db.objectStoreNames.contains('files')) db.createObjectStore('files'); } 
});

const container = createContainer();
const vfs = container.vfs;
let editor, currentFile, isEditorReady = false;

const consoleOutput = document.getElementById('console-output');
const termInput = document.getElementById('terminal-input');

function appendToConsole(text, color = '#ddd') {
    const entry = document.createElement('div');
    entry.style.color = color;
    const cleanText = text.replace(/\x1B\[[0-9;]*[mK]/g, '');
    entry.textContent = cleanText.startsWith('>') ? cleanText : `> ${cleanText}`;
    consoleOutput.appendChild(entry);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

container.on('stdout', data => appendToConsole(data, '#bbb'));
container.on('stderr', data => appendToConsole(data, '#ff5555'));

/**
 * 3. TERMINAL COMMAND ENGINE
 */
async function runCommand(cmdString) {
    const input = cmdString.trim();
    if (!input) return;

    appendToConsole(`$ ${input}`, '#00aaff');
    const args = input.split(/\s+/);
    const command = args.shift();

    try {
        if (command === 'npm') {
            const action = args.shift();
            const pkgName = args[0];

            if (action === 'install' || action === 'i') {
                if (pkgName) {
                    appendToConsole(`Installing ${pkgName}...`, "yellow");
                    await container.npm.install(pkgName);
                } else {
                    appendToConsole("Installing dependencies from package.json...", "yellow");
                    await container.npm.install();
                }
                renderSidebar();
                appendToConsole("NPM Install Complete", "#0f0");
            } 
            else if (action === 'uninstall') {
                appendToConsole(`Removing ${pkgName}...`, "orange");
                await container.npm.uninstall(pkgName);
                renderSidebar();
            }
            else if (action === 'list' || action === 'ls') {
                const modules = vfs.readdirSync('/node_modules').filter(f => !f.startsWith('.'));
                appendToConsole("Installed: " + (modules.length ? modules.join(', ') : 'none'));
            }
        } 
        else if (command === 'ls') {
            const path = args[0] || '/';
            const files = vfs.readdirSync(path);
            appendToConsole(files.join('  '));
        } 
        else if (command === 'clear') {
            consoleOutput.innerHTML = '';
        } 
        else if (command === 'vite' || command === 'start') {
            window.startViteServer();
        }
        else {
            appendToConsole(`Command not found: ${command}`, "red");
        }
    } catch (err) {
        appendToConsole("Error: " + err.message, "#ff5555");
    }
}

// Attach listener to the input field
if (termInput) {
    termInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            runCommand(termInput.value);
            termInput.value = '';
        }
    });
}

/**
 * 4. VITE DEV SERVER & TEMPLATE LOGIC
 */
window.startViteServer = async () => {
    appendToConsole("Starting dev server...", "#0af");
    try {
        if (!vfs.existsSync('/node_modules/vite')) {
            appendToConsole("Vite not found. Running installation...", "yellow");
            await window.importStarterTemplate();
        }

        const vite = await container.spawn('npx', ['vite', '--host', '--port', '3000']);
        vite.stdout.on('data', (data) => {
            appendToConsole(data);
            if (data.includes('Local:')) {
                const virtualUrl = `${window.location.origin}/__virtual__/3000/`;
                const frame = document.getElementById('preview-frame');
                frame.src = virtualUrl;
                frame.style.display = 'block';
                appendToConsole("Preview started", "#0f0");
            }
        });
    } catch (e) { appendToConsole("Vite Error: " + e.message, 'red'); }
};

window.importStarterTemplate = async () => {
    appendToConsole("Creating Vite project structure...", "#0af");
    const dirs = ['/src', '/public'];
    dirs.forEach(d => { if(!vfs.existsSync(d)) vfs.mkdirSync(d); });

    const files = {
        '/package.json': JSON.stringify({ 
            name: "vite-app", 
            type: "module", 
            dependencies: { "react": "18.2.0", "react-dom": "18.2.0" }, 
            devDependencies: { "vite": "5.0.12", "@vitejs/plugin-react": "4.2.1" } 
        }, null, 2),
        '/vite.config.js': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()], server: { port: 3000, hmr: { protocol: 'ws', host: 'localhost' } } });`,
        '/index.html': `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`,
        '/src/main.jsx': `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App.jsx';\nReactDOM.createRoot(document.getElementById('root')).render(<App />);`,
        '/src/App.jsx': `import React, { useState } from 'react';\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (<div><h1>⚡ Vite + React</h1><button onClick={() => setCount(c => c + 1)}>Count: {count}</button></div>);\n}`
    };

    const db = await dbPromise;
    for (const [path, code] of Object.entries(files)) {
        vfs.writeFileSync(path, code);
        await db.put('files', code, path);
    }

    renderSidebar();
    appendToConsole("=== Installing Dependencies ===", "yellow");
    await container.npm.install();
    appendToConsole("Ready!", "#0f0");
};

/**
 * 5. EDITOR & BOOTSTRAP
 */
async function openFile(fullPath) {
    if (!isEditorReady) return;
    currentFile = fullPath;
    const content = vfs.readFileSync(fullPath, 'utf8');
    editor.setValue(content);
    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active-file'));
    renderSidebar();
}

(async () => {
    if (window.editorInitialized) return;
    window.editorInitialized = true;

    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.36.1/min/vs' } });
    require(['vs/editor/editor.main'], async function () {
        editor = monaco.editor.create(document.getElementById('monaco-editor'), {
            theme: 'vs-dark', automaticLayout: true, fontSize: 12, minimap: { enabled: false }
        });
        
        editor.onDidChangeModelContent(async () => {
            if (currentFile) {
                const code = editor.getValue();
                vfs.writeFileSync(currentFile, code);
                const db = await dbPromise;
                await db.put('files', code, currentFile);
            }
        });

        isEditorReady = true;
        const db = await dbPromise;
        const keys = await db.getAllKeys('files');
        for (const k of keys) {
            const content = await db.get('files', k);
            const parts = k.split('/').slice(0, -1);
            let p = '';
            parts.forEach(part => { 
                if(part) { p += '/' + part; if(!vfs.existsSync(p)) vfs.mkdirSync(p); } 
            });
            vfs.writeFileSync(k, content);
        }

        renderSidebar();
        if (keys.length > 0) openFile(keys.find(k => k.endsWith('App.jsx')) || keys[0]);
        appendToConsole("IDE Ready.");
    });
})();

window.openFile = openFile;
window.renderSidebar = renderSidebar;

function buildTree(path, parentElement) {
    const items = vfs.readdirSync(path);
    items.sort((a, b) => (a === 'node_modules' ? -1 : 1));
    items.forEach(name => {
        const fullPath = `${path}/${name}`.replace('//', '/');
        const stats = vfs.statSync(fullPath);
        if (stats.isDirectory()) {
            const wrap = document.createElement('div');
            wrap.className = 'tree-item';
            wrap.innerHTML = `<div class="folder-header"><i class="fas fa-folder"></i> ${name}</div>`;
            const content = document.createElement('div');
            content.className = 'folder-content';
            wrap.querySelector('.folder-header').onclick = () => content.classList.toggle('expanded');
            wrap.appendChild(content);
            parentElement.appendChild(wrap);
            if (name !== 'node_modules') buildTree(fullPath, content);
        } else {
            const fileDiv = document.createElement('div');
            fileDiv.className = `file-item ${currentFile === fullPath ? 'active-file' : ''}`;
            fileDiv.innerHTML = `<i class="far fa-file-code"></i> ${name}`;
            fileDiv.onclick = () => openFile(fullPath);
            parentElement.appendChild(fileDiv);
        }
    });
}

function renderSidebar() {
    const list = document.getElementById('file-list');
    if (!list) return;
    list.innerHTML = '';
    buildTree('/', list);
}
