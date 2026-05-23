const state = {
    materials: '',
    projects: [],
    activeProject: null,
    activeInstructions: []
};

const elements = {
    chatInput: document.getElementById('chatInput'),
    sendChatBtn: document.getElementById('sendChatBtn'),
    chatMessages: document.getElementById('chatMessages'),
    welcomeMessage: document.getElementById('welcomeMessage'),
    projectsContainer: document.getElementById('projectsContainer'),
    instructionsArea: document.getElementById('instructionsArea'),
    instructionsContainer: document.getElementById('instructionsContainer'),
    learnArea: document.getElementById('learnArea'),
    learnTitle: document.getElementById('learnTitle'),
    learnContainer: document.getElementById('learnContainer'),
    learnHomeBtn: document.getElementById('learnHomeBtn'),
    closeInstructions: document.getElementById('closeInstructions'),
    projectCounter: document.getElementById('projectCounter'),
    trickButton: document.getElementById('trickButton'),
    trickButtonContainer: document.getElementById('trickButtonContainer')
};

const STORAGE_KEY = 'elexit-builds-validated';

function setBusy(isBusy, label = 'Send Signal') {
    elements.sendChatBtn.disabled = isBusy;
    elements.sendChatBtn.textContent = isBusy ? 'Transmitting...' : label;
    elements.sendChatBtn.classList.toggle('opacity-60', isBusy);
    elements.sendChatBtn.classList.toggle('cursor-not-allowed', isBusy);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function cleanSvg(svgCode) {
    const svg = String(svgCode || '').trim();

    if (!svg.startsWith('<svg') || !svg.endsWith('</svg>')) {
        return `<svg viewBox="0 0 500 350" xmlns="http://www.w3.org/2000/svg"><rect width="500" height="350" fill="#000000"/><text x="36" y="180" fill="#e2e8f0" font-size="20">Blueprint visual unavailable</text></svg>`;
    }

    return svg
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/\son\w+="[^"]*"/gi, '')
        .replace(/\son\w+='[^']*'/gi, '');
}

function addMessage(text, role = 'mentor') {
    const message = document.createElement('div');
    const roleClasses = role === 'user'
        ? 'self-end bg-cyan-950 border-cyan-800 text-cyan-100'
        : 'bg-gray-800 border-cyan-900 text-cyan-200';

    message.className = `${roleClasses} border font-mono rounded-lg p-3 max-w-md shadow-inner`;
    message.innerHTML = `<p class="text-xs leading-relaxed">${escapeHtml(text)}</p>`;
    elements.chatMessages.appendChild(message);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
}

async function postJson(url, payload) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.error || 'The signal could not be processed.');
    }

    return data;
}

function renderProjects(projects) {
    elements.welcomeMessage.classList.add('hidden');
    elements.instructionsArea.classList.add('hidden');
    elements.learnArea.classList.add('hidden');
    elements.projectsContainer.classList.remove('hidden');
    elements.projectsContainer.innerHTML = '';

    projects.forEach((project) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'text-left bg-gray-900 border border-gray-800 hover:border-cyan-400 rounded-2xl p-5 transition-all shadow-xl hover:-translate-y-1 focus:outline-none focus:ring-2 focus:ring-cyan-500';
        card.innerHTML = `
            <div class="text-xs font-mono text-emerald-400 mb-3">${escapeHtml(project.difficulty || 'Medium')} - ${escapeHtml(project.estimatedTime || 'TBD')}</div>
            <h3 class="text-xl font-black text-gray-100 mb-3">${escapeHtml(project.name || 'Untitled Blueprint')}</h3>
            <p class="text-sm text-gray-400 leading-relaxed">${escapeHtml(project.description || 'A custom build generated from your materials.')}</p>
        `;
        card.addEventListener('click', () => loadInstructions(project));
        elements.projectsContainer.appendChild(card);
    });
}

function renderInstructions(instructions) {
    elements.projectsContainer.classList.add('hidden');
    elements.learnArea.classList.add('hidden');
    elements.instructionsArea.classList.remove('hidden');
    elements.trickButtonContainer.classList.add('hidden');
    elements.instructionsContainer.innerHTML = '';

    instructions.forEach((item, index) => {
        const step = document.createElement('article');
        step.className = 'bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-5 shadow-xl';
        step.innerHTML = `
            <div class="flex flex-col lg:flex-row gap-5">
                <div class="lg:w-2/5">
                    <div class="text-xs font-mono text-cyan-400 uppercase tracking-widest mb-2">Step ${escapeHtml(item.step || index + 1)}</div>
                    <h3 class="text-xl font-black text-gray-100 mb-3">${escapeHtml(item.instruction || 'Follow this assembly step.')}</h3>
                    <p class="text-sm text-gray-400 leading-relaxed">${escapeHtml(item.tips || 'Work slowly and check alignment before moving on.')}</p>
                </div>
                <div class="lg:w-3/5 svg-blueprint-container bg-black border border-gray-800 rounded-xl p-3 overflow-hidden">
                    ${cleanSvg(item.svgCode)}
                </div>
            </div>
        `;
        elements.instructionsContainer.appendChild(step);
    });

    const completeButton = document.createElement('button');
    completeButton.type = 'button';
    completeButton.className = 'w-full bg-emerald-500 hover:bg-emerald-400 text-gray-950 font-black rounded-xl px-5 py-3 transition-all active:scale-[0.99]';
    completeButton.textContent = 'Complete Build';
    completeButton.addEventListener('click', completeBuild);
    elements.instructionsContainer.appendChild(completeButton);
}

function renderCompletionChoices() {
    const panel = document.createElement('section');
    panel.className = 'bg-gray-900 border border-emerald-900 rounded-2xl p-6 mt-5 shadow-xl';
    panel.innerHTML = `
        <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
                <div class="text-xs font-mono text-emerald-400 uppercase tracking-widest mb-2">Build Complete</div>
                <h3 class="text-2xl font-black text-gray-100 mb-2">Nice work. Want to learn why it worked?</h3>
                <p class="text-sm text-gray-400 leading-relaxed">You can open a simple explanation written like a friendly third-grade lesson, or return home and start another build.</p>
            </div>
            <div class="flex flex-col sm:flex-row gap-3 md:shrink-0">
                <button type="button" id="openLearnBtn" class="bg-cyan-400 hover:bg-cyan-300 text-gray-950 font-black rounded-xl px-5 py-3 transition-all active:scale-[0.99]">Learn Why It Works</button>
                <button type="button" id="completeHomeBtn" class="border border-gray-700 hover:border-cyan-400 text-gray-300 hover:text-cyan-300 font-black rounded-xl px-5 py-3 transition-all">Back Home</button>
            </div>
        </div>
    `;

    elements.instructionsContainer.appendChild(panel);
    document.getElementById('openLearnBtn').addEventListener('click', loadLearn);
    document.getElementById('completeHomeBtn').addEventListener('click', resetHome);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderLearn(text) {
    elements.welcomeMessage.classList.add('hidden');
    elements.projectsContainer.classList.add('hidden');
    elements.instructionsArea.classList.add('hidden');
    elements.learnArea.classList.remove('hidden');
    elements.learnTitle.textContent = state.activeProject
        ? `Why ${state.activeProject.name} Works`
        : 'Why It Works';

    const paragraphs = String(text || '')
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean);

    elements.learnContainer.innerHTML = paragraphs.map((paragraph) => (
        `<p class="text-lg text-gray-200 leading-relaxed mb-4">${escapeHtml(paragraph)}</p>`
    )).join('');
    elements.learnArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadProjects(materials) {
    setBusy(true);
    addMessage(materials, 'user');
    addMessage('Mapping your materials into buildable project blueprints...');

    const data = await postJson('/api/generate-projects', { materials });
    state.materials = materials;
    state.projects = data.projects || [];
    renderProjects(state.projects);
    addMessage('I drafted three project paths. Pick a blueprint card to generate the assembly steps.');
}

async function loadInstructions(project) {
    state.activeProject = project;
    setBusy(true, 'Mentor Chat');
    addMessage(`Generating instructions for ${project.name}...`);

    try {
        const data = await postJson('/api/generate-instructions', {
            projectName: project.name,
            materials: state.materials
        });
        state.activeInstructions = data.instructions || [];
        renderInstructions(state.activeInstructions);
        addMessage('Blueprint sequence compiled. Use the chat box for step-specific help while you build.');
    } catch (error) {
        addMessage(error.message);
    } finally {
        setBusy(false, 'Mentor Chat');
    }
}

async function loadLearn() {
    elements.welcomeMessage.classList.add('hidden');
    elements.projectsContainer.classList.add('hidden');
    elements.instructionsArea.classList.add('hidden');
    elements.learnArea.classList.remove('hidden');
    elements.learnTitle.textContent = 'Building Your Learn Tab...';
    elements.learnContainer.innerHTML = '<p class="text-lg text-gray-300 leading-relaxed">Writing a simple explanation...</p>';

    try {
        const data = await postJson('/api/learn-project', {
            projectName: state.activeProject ? state.activeProject.name : 'this project',
            materials: state.materials,
            instructions: state.activeInstructions
        });
        renderLearn(data.answer);
        addMessage('Learn tab opened. I kept it simple and kid-friendly.');
    } catch (error) {
        renderLearn('This project works because its pieces help each other. Some pieces hold the shape, some guide the movement, and some keep everything from slipping around. Try changing one small part and watch what changes.');
        addMessage(error.message);
    }
}

async function sendMentorMessage(text) {
    setBusy(true, 'Mentor Chat');
    addMessage(text, 'user');

    const context = state.activeProject
        ? `Active project: ${state.activeProject.name}. Materials: ${state.materials}.`
        : `Materials: ${state.materials || 'not provided yet'}.`;

    const data = await postJson('/api/mentor-chat', { text, context });
    addMessage(data.answer || 'Keep the build aligned, test fit before fastening, and send me the next sticking point.');
}

async function handleSend() {
    const text = elements.chatInput.value.trim();
    if (!text) {
        addMessage('Send me your materials first, like "cardboard, tape, skewers, rubber bands."');
        return;
    }

    elements.chatInput.value = '';

    try {
        if (!state.materials || !state.projects.length) {
            await loadProjects(text);
        } else {
            await sendMentorMessage(text);
        }
    } catch (error) {
        addMessage(error.message);
    } finally {
        setBusy(false, state.projects.length ? 'Mentor Chat' : 'Send Signal');
    }
}

function completeBuild() {
    const existingPanel = document.getElementById('openLearnBtn');
    if (existingPanel) return;

    const count = Number(localStorage.getItem(STORAGE_KEY) || '0') + 1;
    localStorage.setItem(STORAGE_KEY, String(count));
    elements.projectCounter.textContent = count;
    elements.trickButtonContainer.classList.remove('hidden');
    addMessage('Build validated. Nice work. The counter is updated and the calibration note is unlocked.');
    renderCompletionChoices();
}

function resetHome() {
    state.materials = '';
    state.projects = [];
    state.activeProject = null;
    state.activeInstructions = [];

    elements.projectsContainer.innerHTML = '';
    elements.instructionsContainer.innerHTML = '';
    elements.learnContainer.innerHTML = '';
    elements.projectsContainer.classList.add('hidden');
    elements.instructionsArea.classList.add('hidden');
    elements.learnArea.classList.add('hidden');
    elements.welcomeMessage.classList.remove('hidden');
    elements.trickButtonContainer.classList.add('hidden');
    elements.chatInput.value = '';
    setBusy(false, 'Send Signal');
    addMessage('Ready for a new build. Send the next set of materials when you want.');
}

function showCoreInsight() {
    addMessage('Core insight: prototypes improve fastest when every test answers one specific question. Change one variable, observe, then reinforce the winning geometry.');
}

function init() {
    elements.projectCounter.textContent = localStorage.getItem(STORAGE_KEY) || '0';
    elements.sendChatBtn.addEventListener('click', handleSend);
    elements.chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') handleSend();
    });
    elements.closeInstructions.addEventListener('click', () => {
        elements.instructionsArea.classList.add('hidden');
        elements.projectsContainer.classList.remove('hidden');
    });
    elements.learnHomeBtn.addEventListener('click', resetHome);
    elements.trickButton.addEventListener('click', showCoreInsight);
}

init();
