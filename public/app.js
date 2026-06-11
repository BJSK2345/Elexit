const $ = (id) => document.getElementById(id);

const state = {
  projects: [],
  savedProjects: [],
  activeProject: null,
  instructions: [],
  stepIndex: 0,
  request: '',
  theme: localStorage.getItem('elexit.theme') || 'dark'
};

const els = {
  sidebar: $('sidebar'),
  sidebarToggle: $('sidebarToggle'),
  newProjectBtn: $('newProjectBtn'),
  savedList: $('savedList'),
  chat: $('chat'),
  projectForm: $('projectForm'),
  requestInput: $('requestInput'),
  sendBtn: $('sendBtn'),
  modelSelect: $('modelSelect'),
  pageTitle: $('pageTitle'),
  pageMeta: $('pageMeta'),
  views: [...document.querySelectorAll('.view')],
  nav: [...document.querySelectorAll('.side-link')],
  backBtn: $('backBtn'),
  stepBadge: $('stepBadge'),
  stepTitle: $('stepTitle'),
  stepText: $('stepText'),
  stepCheck: $('stepCheck'),
  stepTip: $('stepTip'),
  imageStage: $('imageStage'),
  projectPill: $('projectPill'),
  materialsBackBtn: $('materialsBackBtn'),
  materialsTitle: $('materialsTitle'),
  materialsSummary: $('materialsSummary'),
  materialsList: $('materialsList'),
  confirmMaterialsBtn: $('confirmMaterialsBtn'),
  prevStep: $('prevStep'),
  nextStep: $('nextStep'),
  saveProjectBtn: $('saveProjectBtn'),
  labProjects: $('labProjects'),
  toast: $('toast')
};

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => els.toast.classList.add('hidden'), 2600);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function selectedModel() {
  return els.modelSelect.value || 'groq:openai/gpt-oss-120b';
}

function showView(name) {
  els.views.forEach((view) => view.classList.toggle('active', view.id === `${name}View`));
  els.nav.forEach((item) => item.classList.toggle('active', item.dataset.view === name));
}

function addMessage(type, html) {
  const node = document.createElement('div');
  node.className = `message ${type}`;
  node.innerHTML = html;
  els.chat.appendChild(node);
  els.chat.scrollTop = els.chat.scrollHeight;
  return node;
}

function renderProjectCards(projects) {
  return `<div class="project-grid">${projects.map((project, index) => `
    <button class="project-card" data-project-index="${index}" type="button">
      <span class="tag">${escapeHtml(project.difficulty)}</span>
      <h3>${escapeHtml(project.name)}</h3>
      <p class="muted">${escapeHtml(project.description)}</p>
      <div class="material-preview">
        ${(project.requiredMaterials || []).slice(0, 5).map((material) => `<span>${escapeHtml(material)}</span>`).join('')}
      </div>
      <p><strong>${escapeHtml(project.estimatedTime || '1 hr')}</strong></p>
    </button>
  `).join('')}</div>`;
}

function bindProjectCards(root) {
  root.querySelectorAll('[data-project-index]').forEach((button) => {
    button.addEventListener('click', () => showMaterialsReview(state.projects[Number(button.dataset.projectIndex)]));
  });
}

function showMaterialsReview(project) {
  state.activeProject = project;
  state.instructions = [];
  state.stepIndex = 0;
  els.pageTitle.textContent = project.name;
  els.pageMeta.textContent = 'Review materials first';
  els.materialsTitle.textContent = project.name;
  els.materialsSummary.textContent = project.learningGoal || project.description || 'Check these supplies before starting.';
  const materials = project.requiredMaterials?.length ? project.requiredMaterials : ['safe workspace', 'tape', 'paper or cardboard', 'small test weights'];
  els.materialsList.innerHTML = materials.map((material, index) => `
    <label class="material-item">
      <input type="checkbox" ${index < 2 ? 'checked' : ''}>
      <span>${escapeHtml(material)}</span>
    </label>
  `).join('');
  showView('materials');
}

async function generateProjects(event) {
  event?.preventDefault();
  const request = els.requestInput.value.trim();
  if (!request) return;
  state.request = request;
  els.requestInput.value = '';
  addMessage('user', escapeHtml(request));
  const loading = addMessage('ai', 'Generating project ideas...');
  els.sendBtn.disabled = true;
  try {
    const data = await postJson('/api/generate-projects', { request, model: selectedModel() });
    state.projects = data.projects || [];
    loading.innerHTML = `Pick one to build:${renderProjectCards(state.projects)}`;
    bindProjectCards(loading);
    if (data.fallback) toast('AI fell back to local project ideas.');
  } catch (error) {
    loading.textContent = error.message;
  } finally {
    els.sendBtn.disabled = false;
  }
}

async function startProject(project) {
  state.activeProject = project;
  state.instructions = [];
  state.stepIndex = 0;
  els.pageTitle.textContent = project.name;
  els.pageMeta.textContent = 'Generating detailed build guide';
  els.projectPill.textContent = project.name;
  showView('instructions');
  els.imageStage.innerHTML = '<div class="muted">Generating detailed image...</div>';
  els.stepTitle.textContent = 'Building your guide...';
  els.stepText.textContent = 'The model is creating clear steps and detailed instruction images.';
  try {
    const data = await postJson('/api/generate-instructions', { project, request: state.request, model: selectedModel() });
    state.instructions = data.instructions || [];
    if (data.fallback) toast('AI image plan failed, using detailed local diagrams.');
    renderStep();
    hydrateStepImages();
  } catch (error) {
    toast(error.message);
    showView('projects');
  }
}

function renderStep() {
  const step = state.instructions[state.stepIndex];
  if (!step) return;
  els.stepBadge.textContent = `Step ${step.step || state.stepIndex + 1}`;
  els.stepTitle.textContent = step.title || `Step ${state.stepIndex + 1}`;
  els.stepText.textContent = step.instruction || '';
  els.stepCheck.innerHTML = `<strong>Check:</strong> ${escapeHtml(step.check || 'The build should look stable and aligned.')}`;
  els.stepTip.textContent = step.tip || '';
  els.imageStage.innerHTML = step.svgCode || '<div class="muted">Generating AI image for this step...</div>';
  els.prevStep.disabled = state.stepIndex === 0;
  els.nextStep.textContent = state.stepIndex === state.instructions.length - 1 ? '✓' : '→';
}

async function hydrateStepImages() {
  const project = state.activeProject;
  if (!project) return;

  for (let index = 0; index < state.instructions.length; index += 1) {
    const step = state.instructions[index];
    if (step.svgCode) continue;
    try {
      const data = await postJson('/api/generate-step-svg', { project, step, model: selectedModel() });
      step.svgCode = data.svgCode;
      step.aiImageMissing = !!data.fallback;
      if (state.activeProject === project && state.stepIndex === index) renderStep();
    } catch (error) {
      if (state.activeProject === project && state.stepIndex === index) {
        els.imageStage.innerHTML = `<div class="muted">${escapeHtml(error.message)}</div>`;
      }
    }
  }
}

async function saveActiveProject() {
  if (!state.activeProject) return;
  try {
    const data = await postJson('/api/save-project', { project: state.activeProject, instructions: state.instructions });
    state.savedProjects = data.projects || [];
    renderSaved();
    toast('Saved. It is now in the sidebar.');
  } catch (error) {
    toast(error.message);
  }
}

async function loadSaved() {
  const response = await fetch('/api/saved-projects');
  const data = await response.json();
  state.savedProjects = data.projects || [];
  renderSaved();
}

function renderSaved() {
  if (!state.savedProjects.length) {
    els.savedList.innerHTML = '<p class="empty">Saved projects show here only after you press Save project.</p>';
    els.labProjects.innerHTML = '<p class="muted">No saved projects yet.</p>';
    return;
  }
  els.savedList.innerHTML = state.savedProjects.map((project, index) => `
    <button class="saved-item" data-saved-index="${index}" type="button">
      <strong>${escapeHtml(project.name)}</strong>
      <span>${escapeHtml(project.difficulty || 'Project')}</span>
    </button>
  `).join('');
  els.labProjects.innerHTML = state.savedProjects.map((project, index) => `
    <button class="project-card" data-saved-index="${index}" type="button">
      <span class="tag">${escapeHtml(project.difficulty || 'Saved')}</span>
      <h3>${escapeHtml(project.name)}</h3>
      <p class="muted">${escapeHtml(project.learningGoal || project.description || '')}</p>
    </button>
  `).join('');
  document.querySelectorAll('[data-saved-index]').forEach((button) => {
    button.addEventListener('click', () => openSavedProject(state.savedProjects[Number(button.dataset.savedIndex)]));
  });
}

function openSavedProject(project) {
  state.activeProject = project;
  state.instructions = project.instructions || [];
  state.stepIndex = 0;
  els.pageTitle.textContent = project.name;
  els.pageMeta.textContent = 'Saved project';
  els.projectPill.textContent = project.name;
  showView('instructions');
  renderStep();
}

function newProject() {
  state.projects = [];
  state.activeProject = null;
  state.instructions = [];
  els.chat.innerHTML = '<div class="message ai">What are we building?</div>';
  els.pageTitle.textContent = 'New project';
  els.pageMeta.textContent = 'Build something real';
  showView('projects');
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('elexit.theme', theme);
}

function initEvents() {
  els.projectForm.addEventListener('submit', generateProjects);
  els.requestInput.addEventListener('input', () => {
    els.requestInput.style.height = 'auto';
    els.requestInput.style.height = `${Math.min(els.requestInput.scrollHeight, 150)}px`;
  });
  els.requestInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      els.projectForm.requestSubmit();
    }
  });
  els.sidebarToggle.addEventListener('click', () => {
    if (matchMedia('(max-width: 850px)').matches) document.body.classList.toggle('sidebar-open');
    else document.body.classList.toggle('sidebar-closed');
  });
  els.newProjectBtn.addEventListener('click', newProject);
  els.backBtn.addEventListener('click', () => showView('projects'));
  els.materialsBackBtn.addEventListener('click', () => showView('projects'));
  els.confirmMaterialsBtn.addEventListener('click', () => {
    if (!state.activeProject) return;
    startProject(state.activeProject);
  });
  els.prevStep.addEventListener('click', () => {
    state.stepIndex = Math.max(0, state.stepIndex - 1);
    renderStep();
  });
  els.nextStep.addEventListener('click', async () => {
    if (state.stepIndex < state.instructions.length - 1) {
      state.stepIndex += 1;
      renderStep();
      return;
    }
    const msg = addMessage('ai', 'Generating Learn explanation...');
    showView('projects');
    const data = await postJson('/api/learn-project', { project: state.activeProject, instructions: state.instructions, model: selectedModel() });
    msg.innerHTML = `<strong>Why it works</strong><br>${escapeHtml(data.answer).replace(/\n/g, '<br>')}`;
  });
  els.saveProjectBtn.addEventListener('click', saveActiveProject);
  els.nav.forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
  document.querySelectorAll('[data-theme]').forEach((button) => button.addEventListener('click', () => applyTheme(button.dataset.theme)));
}

applyTheme(state.theme);
initEvents();
loadSaved();
