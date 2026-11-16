// ─── Configuración de Supabase ───────────────────────────────────────────────
const SUPABASE_URL  = 'TU_SUPABASE_URL';      // ← reemplaza esto
const SUPABASE_KEY  = 'TU_SUPABASE_ANON_KEY'; // ← reemplaza esto

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Límites ─────────────────────────────────────────────────────────────────
const MAX_CHARS      = 5000;
const COOLDOWN_MS    = 30000;  // 30s entre envíos
const RANDOM_EVERY   = 30;     // segundos entre frases aleatorias

// ─── App ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const form           = document.getElementById('phraseForm');
    const input          = document.getElementById('phraseInput');
    const message        = document.getElementById('message');
    const phrasesList    = document.getElementById('phrasesList');
    const counter        = document.getElementById('charCounter');
    const submitBtn      = document.getElementById('submitBtn');
    const randomBox      = document.getElementById('randomPhrase');
    const countdownEl    = document.getElementById('randomCountdown');

    let lastSubmit       = 0;
    let countdownValue   = RANDOM_EVERY;
    let countdownTimer   = null;

    // ── Contador de caracteres ────────────────────────────────────────────────
    input.addEventListener('input', () => {
        const len = input.value.length;
        counter.textContent = `${len} / ${MAX_CHARS}`;
        counter.classList.toggle('char-counter--warning', len >= MAX_CHARS * 0.9);
        counter.classList.toggle('char-counter--error',   len >= MAX_CHARS);
    });

    // ── Frase aleatoria ───────────────────────────────────────────────────────
    async function showRandomPhrase() {
        const textEl = randomBox.querySelector('.random-text');

        // fade out
        textEl.classList.add('fade-out');

        const { data, error } = await db
            .from('libro_horrible')
            .select('text')
            .order('created_at', { ascending: false })
            .limit(100);   // trae las 100 más recientes, elige una al azar en cliente

        await new Promise(r => setTimeout(r, 400)); // esperar fade out

        if (error || !data || data.length === 0) {
            textEl.textContent = 'Aún no hay frases guardadas.';
            textEl.classList.add('random-empty');
        } else {
            const pick = data[Math.floor(Math.random() * data.length)];
            textEl.textContent = pick.text;
            textEl.classList.remove('random-empty');
        }

        // fade in
        textEl.classList.remove('fade-out');
    }

    function startCountdown() {
        clearInterval(countdownTimer);
        countdownValue = RANDOM_EVERY;
        countdownEl.textContent = `${countdownValue}s`;

        countdownTimer = setInterval(() => {
            countdownValue--;
            countdownEl.textContent = `${countdownValue}s`;

            if (countdownValue <= 0) {
                countdownValue = RANDOM_EVERY;
                showRandomPhrase();
            }
        }, 1000);
    }

    // ── Cargar frases desde Supabase ─────────────────────────────────────────
    async function loadPhrases() {
        phrasesList.innerHTML = '<p style="text-align:center; color:#999;">Cargando...</p>';

        const { data, error } = await db
            .from('libro_horrible')
            .select('id, created_at, text')
            .order('created_at', { ascending: false });

        if (error) {
            phrasesList.innerHTML = '<p style="text-align:center; color:#c00;">Error al cargar las frases</p>';
            console.error('Supabase error:', error);
            return;
        }

        phrasesList.innerHTML = '';

        if (!data || data.length === 0) {
            phrasesList.innerHTML = '<p style="text-align:center; color:#999;">Aún no hay frases guardadas</p>';
            return;
        }

        data.forEach((phrase) => {
            const card = document.createElement('div');
            card.className = 'phrase-card';
            card.innerHTML = `
                <p>${escapeHtml(phrase.text)}</p>
                <div class="phrase-date">${new Date(phrase.created_at).toLocaleDateString('es-ES', {
                    year:   'numeric',
                    month:  'long',
                    day:    'numeric',
                    hour:   '2-digit',
                    minute: '2-digit'
                })}</div>
            `;
            phrasesList.appendChild(card);
        });
    }

    // ── Guardar frase en Supabase ─────────────────────────────────────────────
    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const text = input.value.trim();

        if (text === '') {
            showMessage('Por favor escribe una frase', 'error');
            return;
        }

        if (text.length > MAX_CHARS) {
            showMessage(`El texto no puede superar los ${MAX_CHARS} caracteres`, 'error');
            return;
        }

        const now = Date.now();
        const remaining = Math.ceil((COOLDOWN_MS - (now - lastSubmit)) / 1000);
        if (lastSubmit && now - lastSubmit < COOLDOWN_MS) {
            showMessage(`Espera ${remaining}s antes de guardar otra frase`, 'error');
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Guardando...';

        const { error } = await db
            .from('libro_horrible')
            .insert({ text });

        submitBtn.disabled = false;
        submitBtn.textContent = 'Guardar Frase';

        if (error) {
            showMessage('Error al guardar la frase', 'error');
            console.error('Supabase error:', error);
            return;
        }

        lastSubmit = Date.now();
        showMessage('¡Frase guardada correctamente!', 'success');
        input.value = '';
        counter.textContent = `0 / ${MAX_CHARS}`;
        counter.classList.remove('char-counter--warning', 'char-counter--error');
        loadPhrases();
    });

    // ── Helpers ───────────────────────────────────────────────────────────────
    function showMessage(text, type) {
        message.textContent = text;
        message.style.background = type === 'success' ? '#d4edda' : '#f8d7da';
        message.style.color      = type === 'success' ? '#155724' : '#721c24';

        setTimeout(() => {
            message.textContent      = '';
            message.style.background = '';
            message.style.color      = '';
        }, 3000);
    }

    function escapeHtml(str) {
        return str
            .replace(/&/g,  '&amp;')
            .replace(/</g,  '&lt;')
            .replace(/>/g,  '&gt;')
            .replace(/"/g,  '&quot;')
            .replace(/'/g,  '&#039;');
    }

    // ── Arrancar ──────────────────────────────────────────────────────────────
    loadPhrases();
    showRandomPhrase();
    startCountdown();
});
