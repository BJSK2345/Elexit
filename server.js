require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'elexit-data.json');

const DEFAULT_MODEL = 'groq:openai/gpt-oss-120b';
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const FEATHERLESS_BASE_URL = process.env.AI_BASE_URL || 'https://api.featherless.ai/v1';
const SAFETY_PATTERN = /\b(address|phone|email|password|meet\s*me|weapon|knife|gun|fire|flame|explosive|high\s*voltage|mains|chemical|acid|adult|nsfw|personal\s*info)\b/i;

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let gemini;

function getGemini() {
  if (!gemini) gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
  return gemini;
}

function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ savedProjects: [], labRuns: [] }, null, 2));
  }
}

function readData() {
  ensureData();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { savedProjects: [], labRuns: [] };
  }
}

function writeData(data) {
  ensureData();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function clean(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function isUnsafe(value) {
  return SAFETY_PATTERN.test(clean(value));
}

function stripCodeFences(value) {
  return clean(value).replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
}

function extractJson(value) {
  const source = stripCodeFences(value);
  const firstArray = source.indexOf('[');
  const lastArray = source.lastIndexOf(']');
  const firstObj = source.indexOf('{');
  const lastObj = source.lastIndexOf('}');
  if (firstArray !== -1 && lastArray > firstArray) return JSON.parse(source.slice(firstArray, lastArray + 1));
  if (firstObj !== -1 && lastObj > firstObj) return JSON.parse(source.slice(firstObj, lastObj + 1));
  throw new Error('No JSON found in model response.');
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function modelInfo(model) {
  const id = clean(model, DEFAULT_MODEL);
  if (id.startsWith('featherless:')) return { id: id.replace(/^featherless:/, ''), provider: 'featherless', raw: id };
  if (id.startsWith('groq:')) return { id: id.replace(/^groq:/, ''), provider: 'groq', raw: id };
  if (id.startsWith('gemini:')) return { id: id.replace(/^gemini:/, ''), provider: 'gemini', raw: id };
  if (id.startsWith('gemini')) return { id, provider: 'gemini', raw: id };
  return { id, provider: 'groq', raw: id };
}

async function askOpenAiCompatible({ prompt, model, apiKey, baseUrl, maxTokens, temperature }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are Elexit, a teen-safe engineering learning assistant. Output valid JSON only when requested. Never suggest unsafe projects.'
        },
        { role: 'user', content: prompt }
      ],
      temperature,
      max_tokens: maxTokens
    })
  }).finally(() => clearTimeout(timeout));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Model request failed (${response.status}).`);
  return clean(data.choices?.[0]?.message?.content);
}

async function askModel(prompt, options = {}) {
  const model = modelInfo(options.model);
  const temperature = options.temperature ?? 0.38;
  const maxTokens = options.maxTokens ?? 5500;

  if (model.provider === 'gemini') {
    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set.');
    const response = await getGemini().models.generateContent({ model: model.id || GEMINI_MODEL, contents: prompt });
    return { text: clean(response.text), model: model.raw || model.id, provider: 'gemini' };
  }

  if (model.provider === 'featherless') {
    if (!process.env.AI_API_KEY) throw new Error('AI_API_KEY is not set.');
    const text = await askOpenAiCompatible({
      prompt,
      model: model.id,
      apiKey: process.env.AI_API_KEY,
      baseUrl: FEATHERLESS_BASE_URL,
      maxTokens,
      temperature
    });
    return { text, model: model.raw || `featherless:${model.id}`, provider: 'featherless' };
  }

  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set.');
  const text = await askOpenAiCompatible({
    prompt,
    model: model.id,
    apiKey: process.env.GROQ_API_KEY,
    baseUrl: 'https://api.groq.com/openai/v1',
    maxTokens,
    temperature
  });
  return { text, model: model.raw || model.id, provider: 'groq' };
}

function projectKind(name = '', materials = '') {
  const value = `${name} ${materials}`.toLowerCase();
  if (/bridge|truss|span/.test(value)) return 'bridge';
  if (/rover|car|vehicle|wheel/.test(value)) return 'rover';
  if (/tower|frame|structure/.test(value)) return 'tower';
  if (/plane|glider|wing|flight/.test(value)) return 'glider';
  if (/launcher|catapult|lever/.test(value)) return 'launcher';
  return 'general';
}

function requestedBuildTarget(request) {
  const source = clean(request).toLowerCase();
  const patterns = [
    /\b(?:i\s+want\s+to|i\s+wanna|can\s+i|please)?\s*(?:make|build|create|construct)\s+(?:a|an|the)?\s*([^,.!?;]+)/i,
    /\b(?:project|build)\s+(?:for|about|called)?\s*([^,.!?;]+)/i
  ];
  for (const pattern of patterns) {
    const match = clean(request).match(pattern);
    if (match?.[1]) return clean(match[1]).replace(/\b(with|using|from|out of)\b.*$/i, '').slice(0, 90);
  }
  if (/\brubber\s*band\b/i.test(source) && /\b(car|rover|vehicle)\b/i.test(source)) return 'rubber band powered car';
  if (/\bballoon\b/i.test(source) && /\b(car|boat|vehicle)\b/i.test(source)) return source.includes('boat') ? 'balloon powered boat' : 'balloon powered car';
  if (/\bbridge\b/i.test(source)) return 'bridge';
  if (/\btower\b/i.test(source)) return 'tower';
  return '';
}

function importantTokens(value) {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'make', 'build', 'create', 'project', 'powered', 'using', 'with', 'from', 'out', 'of', 'my', 'i', 'want']);
  return clean(value).toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 2 && !stop.has(token)) || [];
}

function matchesRequestedTarget(project, target) {
  if (!target) return true;
  const tokens = importantTokens(target);
  if (!tokens.length) return true;
  const haystack = `${project.name || ''} ${project.description || ''} ${project.learningGoal || ''} ${(project.requiredMaterials || []).join(' ')}`.toLowerCase();
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  return hits >= Math.min(2, tokens.length);
}

function projectPrompt({ request, theme, difficulty }) {
  const target = requestedBuildTarget(request);
  return `Generate 3 to 5 safe, satisfying beginner engineering projects for Elexit.

User request/materials: "${clean(request).slice(0, 1000)}"
Detected requested build: "${target || 'none - infer from materials'}"
Theme: "${clean(theme, 'any')}"
Difficulty: "${clean(difficulty, 'any')}"

Rules:
- No fire, weapons, blades, high voltage, chemicals, pressure vessels, unsafe launches, or personal info.
- Use classroom-safe materials.
- The projects should feel buildable and exciting, not generic.
- If the user requested a specific build, EVERY returned project must be that build or a close variation of it.
- Do not change the project category, power source, or vehicle/structure type. For example, if the user asks for a rubber-band-powered car, do not return a balloon boat, bridge, tower, catapult, or unrelated project.
- Use the user's named project in the project name when possible.
- Do not add specialized tools or materials the user did not imply, such as 3D printers, laser cutters, motors, batteries, electronics, or LEGO kits, unless the user specifically mentions them.
- Prefer cardboard, tape, paper, straws, skewers, bottle caps, rubber bands, string, rulers, and small safe test weights.
- Return valid JSON only.

JSON array:
[
  {
    "name": "Project name",
    "difficulty": "Easy | Medium | Hard",
    "estimatedTime": "45 min",
    "description": "Clear one sentence promise.",
    "requiredMaterials": ["material"],
    "learningGoal": "What engineering idea they learn.",
    "safety": "Short safety note."
  }
]`;
}

function instructionPrompt({ project, request }) {
  return `Create a detailed build guide for Elexit.

Project:
${JSON.stringify(project, null, 2)}

Original user request/materials: "${clean(request).slice(0, 1000)}"

Return valid JSON only. Create exactly 8 detailed steps.

The "visualPrompt" field is IMPORTANT. It will be sent to an AI image/SVG generator for that step.

JSON array:
[
  {
    "step": 1,
    "title": "Short step title",
    "instruction": "Detailed beginner-friendly instruction, 1 to 2 sentences.",
    "check": "How the user knows this step is correct.",
    "tip": "Safe helpful tip.",
    "visualPrompt": "Detailed description of the SVG diagram for this exact step: geometry, parts, labels, arrows, measurements, and what changes."
  }
]`;
}

function fallbackTargetProjects(request) {
  const target = requestedBuildTarget(request);
  if (!target) return fallbackProjects(request);
  const title = target.replace(/\b\w/g, (c) => c.toUpperCase());
  const kind = projectKind(target, request);
  const materials = /rubber\s*band|car|rover|vehicle/i.test(`${target} ${request}`)
    ? ['cardboard', 'rubber bands', 'bottle caps', 'skewers', 'tape']
    : ['cardboard', 'tape', 'paper', 'small test weights'];
  return [
    {
      id: crypto.randomUUID(),
      name: title,
      difficulty: 'Medium',
      estimatedTime: '60-90 min',
      description: `Build the requested ${target} and tune one variable to improve performance.`,
      requiredMaterials: materials,
      learningGoal: kind === 'rover' ? 'How stored energy, wheel friction, and axle alignment affect motion.' : 'How design choices affect strength, motion, and stability.',
      safety: 'Use classroom-safe materials, test gently, and stop if anything slips or snaps.',
      source: request
    },
    {
      id: crypto.randomUUID(),
      name: `Compact ${title}`,
      difficulty: 'Easy',
      estimatedTime: '45-60 min',
      description: `A simpler version of the requested ${target} with fewer parts and easier testing.`,
      requiredMaterials: materials.slice(0, 4),
      learningGoal: 'Learn the core mechanism before improving the design.',
      safety: 'Keep tests small and controlled.',
      source: request
    },
    {
      id: crypto.randomUUID(),
      name: `Performance ${title}`,
      difficulty: 'Medium',
      estimatedTime: '90 min',
      description: `A tuning-focused version of the requested ${target} with measurement and comparison runs.`,
      requiredMaterials: [...materials, 'ruler', 'marker'],
      learningGoal: 'Change one variable at a time and compare the result.',
      safety: 'Measure on a clear floor or table away from fragile objects.',
      source: request
    }
  ];
}

function fallbackProjects(request) {
  return [
    {
      id: crypto.randomUUID(),
      name: 'Precision Straw Bridge',
      difficulty: 'Easy',
      estimatedTime: '50 min',
      description: 'Build a lightweight bridge and improve it by changing brace patterns.',
      requiredMaterials: ['straws', 'tape', 'coins', 'two books'],
      learningGoal: 'How triangles spread weight through a structure.',
      safety: 'Use light test weights and keep hands clear while testing.'
    },
    {
      id: crypto.randomUUID(),
      name: 'Rubber Band Distance Rover',
      difficulty: 'Medium',
      estimatedTime: '90 min',
      description: 'Build a small rover and tune wheel spacing, axle friction, and band tension.',
      requiredMaterials: ['cardboard', 'rubber bands', 'bottle caps', 'skewers', 'tape'],
      learningGoal: 'How stored stretch becomes motion.',
      safety: 'Release gently and never aim it at people or pets.'
    },
    {
      id: crypto.randomUUID(),
      name: 'Paper Tower Load Test',
      difficulty: 'Easy',
      estimatedTime: '45 min',
      description: 'Create a tall paper tower and compare how folds and braces change strength.',
      requiredMaterials: ['paper', 'tape', 'coins'],
      learningGoal: 'How shape affects stiffness.',
      safety: 'Use small loads and stop if the tower starts falling.'
    }
  ].map((project) => ({ ...project, source: request }));
}

function normalizeProjects(items, request) {
  if (!Array.isArray(items)) return fallbackTargetProjects(request);
  const target = requestedBuildTarget(request);
  const projects = items
    .filter((item) => item && typeof item === 'object')
    .filter((item) => !isUnsafe(Object.values(item).join(' ')))
    .slice(0, 5)
    .map((item) => ({
      id: crypto.randomUUID(),
      name: clean(item.name, 'Engineering Project').slice(0, 80),
      difficulty: /hard/i.test(item.difficulty) ? 'Hard' : /medium/i.test(item.difficulty) ? 'Medium' : 'Easy',
      estimatedTime: clean(item.estimatedTime, '1 hr').slice(0, 40),
      description: clean(item.description, 'A safe beginner engineering project.').slice(0, 220),
      requiredMaterials: Array.isArray(item.requiredMaterials) ? item.requiredMaterials.map(clean).filter(Boolean).slice(0, 10) : [],
      learningGoal: clean(item.learningGoal, 'Engineering by building and testing.').slice(0, 160),
      safety: clean(item.safety, 'Build gently and stop if anything feels unsafe.').slice(0, 180),
      source: request
    }))
    .filter((project) => matchesRequestedTarget(project, target));
  return projects.length ? projects : fallbackTargetProjects(request);
}

function sanitizeAiSvg(svgCode) {
  const raw = clean(svgCode);
  const start = raw.indexOf('<svg');
  const end = raw.lastIndexOf('</svg>');
  if (start === -1 || end <= start) return '';
  let svg = raw.slice(start, end + 6);
  svg = svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\s(?:on\w+|href|xlink:href)=["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, '');
  if (!/^<svg[\s>]/i.test(svg)) return '';
  if (!/viewBox=/i.test(svg)) svg = svg.replace(/^<svg/i, '<svg viewBox="0 0 700 480"');
  if (!/xmlns=/i.test(svg)) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}

function missingAiSvg(step, index) {
  const title = escapeXml(step?.title || `Step ${index + 1}`);
  return `<svg viewBox="0 0 700 480" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="AI image unavailable"><rect width="700" height="480" rx="28" fill="#f8fafc"/><rect x="42" y="42" width="616" height="396" rx="24" fill="#ffffff" stroke="#d8e2ec" stroke-width="4"/><text x="72" y="116" fill="#111827" font-family="Arial, sans-serif" font-size="30" font-weight="700">${title}</text><text x="72" y="170" fill="#64748b" font-family="Arial, sans-serif" font-size="18">The AI did not return a valid SVG image for this step.</text><text x="72" y="210" fill="#64748b" font-family="Arial, sans-serif" font-size="18">Try generating the project again.</text><path d="M146 326 H554" stroke="#94a3b8" stroke-width="8" stroke-linecap="round" stroke-dasharray="16 18"/><circle cx="350" cy="326" r="42" fill="#e2e8f0" stroke="#94a3b8" stroke-width="6"/></svg>`;
}

function fallbackInstructions(project) {
  const name = project?.name || 'Engineering Project';
  const kind = projectKind(name, project?.requiredMaterials?.join(' '));
  const base = {
    bridge: ['Sort the straightest bridge pieces.', 'Mark the span between two supports.', 'Build two matching side rails.', 'Add cross pieces at equal gaps.', 'Add diagonal triangle braces.', 'Tape the deck to the rails.', 'Place the bridge on supports.', 'Test one small weight in the center.', 'Strengthen the first bending spot.', 'Compare left, center, and right tests.', 'Record what brace pattern worked best.', 'Save the project when you like it.'],
    rover: ['Sort the body, axles, wheels, and band.', 'Mark a center line on the body.', 'Place axle holes evenly.', 'Slide axles through the body.', 'Attach wheels with equal spacing.', 'Add a rubber band anchor.', 'Connect the band to the rear axle.', 'Wind the band gently.', 'Run a short test drive.', 'Fix rubbing wheels or crooked axles.', 'Change one variable and test again.', 'Save the project when you like it.'],
    general: ['Sort safe materials.', 'Sketch the build shape.', 'Lay out the base.', 'Attach the first supports.', 'Add braces or guides.', 'Install the moving or testing part.', 'Check spacing by hand.', 'Run a small safe test.', 'Strengthen the weakest spot.', 'Change one variable.', 'Compare results.', 'Save the project when you like it.']
  };
  const actions = base[kind] || base.general;
  return actions.map((instruction, index) => ({
    step: index + 1,
    title: instruction.replace(/\.$/, ''),
    instruction: `${instruction} Keep the build centered and use small adjustments before adding more tape.`,
    check: 'The part should be lined up, stable, and easy to inspect.',
    tip: 'Test gently and stop if anything slips, bends, or feels unsafe.',
    visual: {
      kind,
      scene: instruction,
      action: `Show ${instruction.toLowerCase()}`,
      parts: project?.requiredMaterials || ['base', 'support', 'test piece'],
      labels: ['base', 'new part', 'alignment', 'test area'],
      measurements: ['equal spacing']
    },
    svgCode: null
  })).map((step, index) => ({ ...step, svgCode: missingAiSvg(step, index), aiImageMissing: true }));
}

function normalizeInstructions(items, project) {
  if (items && !Array.isArray(items) && Array.isArray(items.steps)) items = items.steps;
  if (items && !Array.isArray(items) && Array.isArray(items.instructions)) items = items.instructions;
  if (!Array.isArray(items)) return fallbackInstructions(project);
  const steps = items
    .filter((item) => item && typeof item === 'object')
    .filter((item) => !isUnsafe(`${item.title || ''} ${item.instruction || ''} ${item.tip || ''}`))
    .slice(0, 18)
    .map((item, index) => {
      const step = {
        step: Number(item.step) || index + 1,
        title: clean(item.title, `Step ${index + 1}`).slice(0, 80),
        instruction: clean(item.instruction, 'Build this step carefully.').slice(0, 520),
        check: clean(item.check, 'The piece should line up and feel stable.').slice(0, 220),
        tip: clean(item.tip || item.tips, 'Test gently and stop if anything feels unsafe.').slice(0, 220),
        visualPrompt: clean(item.visualPrompt || item.visual || item.diagramPrompt, '').slice(0, 700)
      };
      return {
        ...step,
        svgCode: '',
        aiImageMissing: true
      };
    });
  return steps.length >= 6 ? steps : fallbackInstructions(project);
}

function modelCandidates(preferred) {
  return Array.from(new Set([
    clean(preferred),
    DEFAULT_MODEL,
    'groq:openai/gpt-oss-120b',
    'groq:llama-3.3-70b-versatile',
    'gemini:gemini-2.5-flash-lite',
    'featherless:meta-llama/Llama-3.3-70B-Instruct',
    'featherless:Qwen/Qwen2.5-72B-Instruct'
  ].filter(Boolean)));
}

function svgRepairPrompt({ project, step }) {
  return `Create ONLY one complete inline SVG for this Elexit build step.

Project:
${JSON.stringify(project, null, 2)}

Step:
${JSON.stringify({
  step: step.step,
  title: step.title,
  instruction: step.instruction,
  check: step.check
}, null, 2)}

Rules:
- Return SVG only. No markdown. No JSON. No explanation.
- Begin with <svg and end with </svg>.
- Use viewBox="0 0 700 480" and xmlns="http://www.w3.org/2000/svg".
- Use only svg, defs, marker, g, rect, circle, ellipse, line, polyline, polygon, path, text.
- No script, foreignObject, image, animation, style tag, external URL, href, or event handlers.
- Make the image specific to this project and this step.
- Show physical geometry, labels, arrows, guides, tape, holes, wheels, axles, braces, folds, supports, dimensions, or test path as appropriate.`;
}

async function repairMissingSvgs(instructions, project, preferredModel) {
  const candidates = modelCandidates(preferredModel);
  const repaired = [];

  for (let index = 0; index < instructions.length; index += 1) {
    const step = { ...instructions[index] };
    if (!step.aiImageMissing && sanitizeAiSvg(step.svgCode)) {
      repaired.push(step);
      continue;
    }

    let svg = '';
    for (const model of candidates) {
      try {
        const answer = await askModel(svgRepairPrompt({ project, step }), { model, maxTokens: 2400, temperature: 0.25 });
        svg = sanitizeAiSvg(answer.text);
        if (svg) {
          step.svgModel = answer.model;
          break;
        }
      } catch (error) {
        console.error(`svg-repair ${model}:`, error.message);
      }
    }
    step.svgCode = svg || missingAiSvg(step, index);
    step.aiImageMissing = !svg;
    repaired.push(step);
  }

  return repaired;
}

async function generateInstructionsWithProviders({ project, request, preferredModel }) {
  const errors = [];
  for (const model of modelCandidates(preferredModel)) {
    try {
      const answer = await askModel(instructionPrompt({ project, request }), { model, maxTokens: 3600, temperature: 0.3 });
      const instructions = normalizeInstructions(extractJson(answer.text), project);
      if (instructions.length >= 6) {
        return { instructions, model: answer.model, provider: answer.provider };
      }
      errors.push(`${model}: not enough steps`);
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
      console.error(`generate-instructions ${model}:`, error.message);
    }
  }
  const fallback = fallbackInstructions(project);
  return { instructions: fallback, fallback: true, error: errors.join(' | ') };
}

function learnText(project, instructions) {
  const name = project?.name || 'This project';
  return `${name} works because each part has a job. Some parts hold the shape, some guide motion, and some carry the test load from one place to another.

When you change size, spacing, weight, angle, or tightness, the whole build reacts. A longer part may reach farther but bend more. A wider base may feel steadier but use more material. A tighter band may move a rover farther, but it can also make the wheels slip.

The best way to improve it is to change one thing at a time. If you change the brace pattern, keep the same weight test. If you change wheel size, keep the same wind-up. That makes the result easy to understand.

Watch for wobble, rubbing, bending, and loose joints. Those are clues. They show where energy is being wasted or where the structure needs a cleaner path for force.

Tiny experiment: run your project once, change one measurement by a small amount, then run it again and compare what improved and what got worse.`;
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, status: 'ready', defaultModel: DEFAULT_MODEL });
});

app.post('/api/generate-projects', async (req, res) => {
  const request = clean(req.body.request || req.body.materials);
  const theme = clean(req.body.theme);
  const difficulty = clean(req.body.difficulty);
  if (!request) return res.status(400).json({ ok: false, error: 'Type what you want to build or what materials you have.' });
  if (isUnsafe(`${request} ${theme} ${difficulty}`)) return res.json({ ok: true, projects: fallbackProjects('safe classroom materials'), warning: 'Unsafe wording was filtered.' });

  try {
    const answer = await askModel(projectPrompt({ request, theme, difficulty }), { model: req.body.model, maxTokens: 3200 });
    const projects = normalizeProjects(extractJson(answer.text), request);
    res.json({ ok: true, projects, model: answer.model });
  } catch (error) {
    console.error('generate-projects:', error.message);
    res.json({ ok: true, projects: fallbackProjects(request), fallback: true, error: error.message });
  }
});

app.post('/api/generate-instructions', async (req, res) => {
  const project = req.body.project || { name: clean(req.body.projectName), requiredMaterials: [] };
  if (!project.name) return res.status(400).json({ ok: false, error: 'Project name is required.' });
  if (isUnsafe(JSON.stringify(project))) return res.json({ ok: true, instructions: fallbackInstructions({ name: 'Safe Engineering Project' }), warning: 'Unsafe wording was filtered.' });

  try {
    const result = await generateInstructionsWithProviders({
      project,
      request: req.body.request || project.source || '',
      preferredModel: req.body.model
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    console.error('generate-instructions:', error.message);
    res.json({ ok: true, instructions: fallbackInstructions(project), fallback: true, error: error.message });
  }
});

app.post('/api/generate-step-svg', async (req, res) => {
  const project = req.body.project || {};
  const step = req.body.step || {};
  if (!project.name || !step.instruction) return res.status(400).json({ ok: false, error: 'Project and step are required.' });

  const prompt = svgRepairPrompt({
    project,
    step: {
      ...step,
      instruction: `${step.instruction}\nVisual goal: ${step.visualPrompt || ''}`
    }
  });

  const errors = [];
  for (const model of modelCandidates(req.body.model)) {
    try {
      const answer = await askModel(prompt, { model, maxTokens: 2600, temperature: 0.22 });
      const svgCode = sanitizeAiSvg(answer.text);
      if (svgCode) return res.json({ ok: true, svgCode, model: answer.model, provider: answer.provider });
      errors.push(`${model}: no valid SVG`);
    } catch (error) {
      errors.push(`${model}: ${error.message}`);
      console.error(`generate-step-svg ${model}:`, error.message);
    }
  }

  res.json({ ok: true, svgCode: missingAiSvg(step, Number(step.step || 1) - 1), fallback: true, error: errors.join(' | ') });
});

app.post('/api/learn-project', async (req, res) => {
  const project = req.body.project || { name: clean(req.body.projectName) };
  try {
    const prompt = `Explain this engineering project in five short beginner-friendly paragraphs. No markdown.
Project: ${JSON.stringify(project)}
Steps: ${JSON.stringify((req.body.instructions || []).map((step) => step.instruction))}`;
    const answer = await askModel(prompt, { model: req.body.model, maxTokens: 1500 });
    res.json({ ok: true, answer: answer.text, model: answer.model });
  } catch {
    res.json({ ok: true, answer: learnText(project, req.body.instructions), fallback: true });
  }
});

app.get('/api/saved-projects', (_req, res) => {
  res.json({ ok: true, projects: readData().savedProjects });
});

app.post('/api/save-project', (req, res) => {
  const project = req.body.project;
  if (!project?.name) return res.status(400).json({ ok: false, error: 'Project is required.' });
  const data = readData();
  const saved = {
    ...project,
    id: project.id || crypto.randomUUID(),
    savedAt: new Date().toISOString(),
    instructions: Array.isArray(req.body.instructions) ? req.body.instructions : []
  };
  data.savedProjects = [saved, ...data.savedProjects.filter((item) => item.name !== saved.name)].slice(0, 20);
  writeData(data);
  res.json({ ok: true, project: saved, projects: data.savedProjects });
});

app.post('/api/delete-saved-project', (req, res) => {
  const name = clean(req.body.name);
  const data = readData();
  data.savedProjects = data.savedProjects.filter((project) => project.name !== name);
  writeData(data);
  res.json({ ok: true, projects: data.savedProjects });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'API route not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  ensureData();
  app.listen(PORT, () => console.log(`Elexit AI running at http://localhost:${PORT}`));
}

module.exports = app;
