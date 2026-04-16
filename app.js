import { createContainer } from 'https://esm.sh/almostnode@0.2.14';
import { openDB } from 'https://esm.sh/idb@8.0.0';

/**
 * 1. SERVICE WORKER REGISTRATION
 * Crucial for Vite to intercept iframe requests.
 */
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { type: 'module' })
        .then(reg => console.log("SW Registered:", reg.scope))
        .catch(err => console.error("SW Failed. Preview will not work without sw.js:", err));
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

// Console Helper
function appendToConsole(text, color = '#ddd') {
    const entry = document.createElement('div');
    entry.style.color = color;
    entry.textContent = text.startsWith('>') ? text : `> ${text}`;
    consoleOutput.appendChild(entry);
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

container.on('stdout', data => appendToConsole(data, '#bbb'));
container.on('stderr', data => appendToConsole(data, '#ff5555'));

/**
 * 3. VITE & NPM LOGIC
 */
async function runCommand(cmdString) {
    const input = cmdString.trim();
    if (!input) return;
    appendToConsole(`$ ${input}`, '#00aaff');
    const args = input.split(/\s+/);
    const command = args.shift();

    try {
        if (command === 'npm') {
            const sub = args.shift();
            if (sub === 'install' || sub === 'i') {
                appendToConsole(`Installing ${args[0]}...`, "yellow");
                await container.npm.install(args[0]);
                renderSidebar();
            }
        } else if (command === 'ls') {
            appendToConsole(vfs.readdirSync(args[0] || '/').join('  '));
        } else if (command === 'clear') {
            consoleOutput.innerHTML = '';
        }
    } catch (err) { appendToConsole(err.message, '#ff5555'); }
}

termInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { runCommand(termInput.value); termInput.value = ''; }
});

window.importStarterTemplate = async () => {
    appendToConsole("Preparing Vite + React environment...", "#0af");
    try {
        const dirs = ['/src', '/public'];
        dirs.forEach(d => { if(!vfs.existsSync(d)) vfs.mkdirSync(d); });

        const files = {
            '/package.json': JSON.stringify({ name: "vite-app", type: "module", dependencies: { "react": "^18", "react-dom": "^18" }, devDependencies: { "vite": "^5" } }, null, 2),
            '/vite.config.js': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()], server: { host: '0.0.0.0' } });`,
            '/index.html': `<!DOCTYPE html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>`,
            '/src/main.jsx': `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App.jsx';\nReactDOM.createRoot(document.getElementById('root')).render(<App />);`,
            '/src/App.jsx': `import React, { useState } from 'react';\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (<div><h1>⚡ Vite + React</h1><button onClick={() => setCount(c => c + 1)}>Count: {count}</button></div>);\n}`
        };

        const db = await dbPromise;
        for (const [path, code] of Object.entries(files)) {
            vfs.writeFileSync(path, code);
            await db.put('files', code, path);
        }

        renderSidebar();
        appendToConsole("Downloading Vite ecosystem (9+ packages)...", "yellow");
        
        await container.npm.install('vite');
        await container.npm.install('@vitejs/plugin-react');
        await container.npm.install('react');
        await container.npm.install('react-dom');
        
        renderSidebar();
        appendToConsole("Installation Complete!", "#0f0");
    } catch (e) { appendToConsole(e.message, 'red'); }
};

window.startViteServer = async () => {
    appendToConsole("Starting Vite Dev Server...", "#0af");
    try {
        const vite = await container.spawn('npx', ['vite', '--host']);
        vite.stdout.on('data', (data) => {
            appendToConsole(data);
            if (data.includes('Local:')) {
                const url = data.match(/http:\/\/localhost:\d+/)[0];
                const frame = document.getElementById('preview-frame');
                frame.src = url;
                frame.style.display = 'block';
            }
        });
    } catch (e) { appendToConsole("Vite Error: " + e.message, 'red'); }
};

/**
 * 4. SIDEBAR & EDITOR
 */
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
            if (name !== 'node_modules') buildTree(fullPath, content); // Don't auto-recurse node_modules (heavy)
        } else {
            const fileDiv = document.createElement('div');
            fileDiv.className = `file-item ${currentFile === fullPath ? 'active-file' : ''}`;
            fileDiv.innerHTML = `<i class="far fa-file-code"></i> ${name}`;
            fileDiv.onclick = () => openFile(fullPath);
            parentElement.appendChild(fileDiv);
        }
    });
}

async function renderSidebar() {
    const list = document.getElementById('file-list');
    list.innerHTML = '';
    buildTree('/', list);
}

window.openFile = (fullPath) => {
    if (!isEditorReady) return;
    currentFile = fullPath;
    editor.setValue(vfs.readFileSync(fullPath, 'utf8'));
    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active-file'));
};

/**
 * 5. BOOTSTRAP
 */
(async () => {
    // Avoid double-loading Monaco
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
                (await dbPromise).put('files', code, currentFile);
            }
        });

        isEditorReady = true;
        const db = await dbPromise;
        const keys = await db.getAllKeys('files');
        for (const k of keys) {
            const content = await db.get('files', k);
            const parts = k.split('/').slice(0, -1);
            let p = '';
            parts.forEach(part => { if(part) { p += '/' + part; if(!vfs.existsSync(p)) vfs.mkdirSync(p); } });
            vfs.writeFileSync(k, content);
        }
        renderSidebar();
        appendToConsole("IDE Ready.");
    });
})();