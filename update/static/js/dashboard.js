// static/js/dashboard.js — Plan F v1.8.0
// Contrato de datos: AnalyticsResult de Plan E v1.5.0 (GET /api/dashboard/<id>)

// ── [Fase 1] Marca de versión: confirma en consola qué JS corre el navegador
// (tras Ctrl+F5 debe aparecer T5; si no, es caché del navegador).
window.__ZENIT_JS_VERSION = "dashboard.js T51_20260909";
console.log("[Zenit] " + window.__ZENIT_JS_VERSION);

const MENSAJES_ERROR = {
    RECURSO_NO_ENCONTRADO: "El dataset solicitado no existe. Selecciona otro de la lista.",
    PARQUET_FALTANTE: "El archivo de datos optimizado no se encuentra en disco. Selecciona el Excel original para reconstruir la caché analítica.",
    MAPEO_INVALIDO: "La configuración de columnas no coincide con los datos. Vuelve a importar el archivo para reconfigurar el mapeo.",
    TIMEOUT_LIMITE: "El motor tardó demasiado en responder (más de 5 segundos). Verifica el tamaño del archivo.",
    DEFAULT: "No se pudo procesar la información. Verifica que la aplicación no esté bloqueada por el sistema.",
};

const PALETA = { primario: "#5B0672", secundario: "#48045B", alerta: "#7C3AED" };

let _charts = {};
let _gridAnomalias = null;
let _metaActual = null;   // [Fase O-3] meta del período para el gauge
let _perfilColumnasActual = null; // [Punto 1] repoblar selectores de ejes
let _kpisActual = null;
let _configActual = null;       // [Paso 5] config vigente para la barra de módulos
let _tabActivoActual = "tab-resumen"; // [Paso 5] tab activo (R-2)
let currentTablaId = null;
// [Frente C · E3] Filtros financieros globales (réplica del B2 Excel)
let _filtroMesActual = null;
let _filtroTipoActual = null;
// [Fase 4] Rango por calendario (fechas ISO YYYY-MM-DD)
let _filtroFechaDesde = null;
let _filtroFechaHasta = null;

// ── Selectores de Eje X / Eje Y (Fundacional §6.1 — Capa 1) ──────────────
let _ejeXActual = null;
let _ejeYActual = null;
let _columnasDisponiblesEjes = [];
let _ejesAutoSeleccionados = false;  // evita loop: solo recarga UNA vez tras auto-selección
let _flagImprimir = false;           // [Fase E1] impresión del dashboard tras render

// ── [R-3b] Drawer de personalización ─────────────────────────────────────────
let _drawerColorPrincipal = "#5B0672";  // color principal actual
let _drawerMostrarMargen = true;        // toggle de margen
let _drawerCategorias = [];             // [{nombre, monto, activo, color}]
let _drawerCategoriasOriginal = [];     // backup para reset

document.addEventListener("DOMContentLoaded", async () => {
    const params = new URLSearchParams(window.location.search);
    currentTablaId = params.get("id") || sessionStorage.getItem("zenit_dataset_activo") || null;
    // [Frente C · E3] Restaurar filtros financieros de la sesión
    _filtroMesActual = sessionStorage.getItem("zenit_filtro_mes") || null;
    _filtroTipoActual = sessionStorage.getItem("zenit_filtro_tipo") || null;
    _filtroMesDesde = sessionStorage.getItem("zenit_filtro_mes_desde") || null;
    _filtroMesHasta = sessionStorage.getItem("zenit_filtro_mes_hasta") || null;
    // [Fase 4] Restaurar rango por fechas del calendario
    _filtroFechaDesde = sessionStorage.getItem("zenit_fecha_desde") || null;
    _filtroFechaHasta = sessionStorage.getItem("zenit_fecha_hasta") || null;
    // [Plan F · 23/08] Período de la Tendencia (Mensual/Anual/Rango) persistentes
    _tendenciaPeriodo = sessionStorage.getItem("zenit_tend_periodo") || "mes";
    if (_tendenciaPeriodo !== "anio" && _tendenciaPeriodo !== "rango") _tendenciaPeriodo = "mes";
    const selTend = document.getElementById("sel-tendencia-periodo");
    if (selTend) selTend.value = _tendenciaPeriodo;
    if (params.get("id")) sessionStorage.setItem("zenit_dataset_activo", params.get("id"));

    // [Fase E1] Impresión del dashboard: si venimos de "Imprimir Dashboard"
    // en /exportar, esperamos a que cargue el dashboard y luego abrimos el
    // diálogo de impresión (window.print) — así imprime los DATOS, no un
    // screenshot de la página de exportar.
    if (sessionStorage.getItem("zenit_imprimir_dash") === "1") {
        sessionStorage.removeItem("zenit_imprimir_dash");
        _flagImprimir = true;
    }

    // [Fix] Sincronizar el estado del botón "Exportar PDF" de la barra lateral
    // al cargar la página (habilitado solo si hay dataset en la URL).
    actualizarBtnPdfNav();

    await poblarSelectorTablas();
    if (currentTablaId) {
        const select = document.getElementById("sel-tabla-activa");
        // [Fix 31/08] Los options del selector son "imp-{id}" (importaciones).
        // Sincronizar la selección con el dataset activo de la URL: buscar la
        // importación que contiene ese bloque y marcarla (antes el select
        // quedaba en "— Selecciona un archivo —" aunque hubiera dataset).
        if (select) {
            try {
                const res = await fetch("/api/importaciones");
                const importaciones = await res.json();
                const impActiva = importaciones.find(i =>
                    (i.hojas || []).some(h => Number(h.bloque_id) === Number(currentTablaId)));
                if (impActiva) {
                    select.value = "imp-" + String(impActiva.id ?? impActiva.importacion_id);
                }
            } catch (_) { /* selección cosmética: no bloquear la carga */ }
        }
        poblarSelectorSecciones();
        cargarDashboard(currentTablaId);
    } else {
        // [O-5] Sin dataset en la URL → estado vacío amigable
        mostrarEstadoVacio();
    }
});

// ─── [Fase E1 · v2] IMPRESIÓN del dashboard — enfoque CSS-class ─────────────
// En vez de manipular el DOM (agregar/quitar elementos que rompen el layout),
// agregamos una clase al <body> y dejamos que CSS haga TODA la transformación
// visual. Esto es más estable, no causa shifts de layout, y es fácil de mantener.
//
// CÓMO FUNCIONA:
//   1. body.zenit-printing activa estilos @media screen que ocultan sidebar/
//      tabs/botones y muestran todas las secciones apiladas verticalmente.
//   2. Los charts Chart.js se redimensionan automáticamente (responsive:true)
//      cuando su contenedor cambia de tamaño.
//   3. window.print() abre el diálogo con el layout ya transformado.
//   4. Al cerrar el diálogo, removemos la clase y todo vuelve a la normalidad.

function _prepararYImprimir() {
    // Activar modo impresión
    document.body.classList.add("zenit-printing");

    // Redimensionar todos los charts para que se ajusten al nuevo layout
    setTimeout(function() {
        if (window.Chart && typeof window.Chart.getChart === "function") {
            document.querySelectorAll("canvas").forEach(function(canvas) {
                try {
                    var ch = window.Chart.getChart(canvas);
                    if (ch && ch.resize) ch.resize();
                } catch (_) {}
            });
        }
        // Abrir diálogo de impresión después del resize
        setTimeout(function() {
            window.print();
            // Restaurar después de imprimir (el diálogo es bloqueante)
            document.body.classList.remove("zenit-printing");
        }, 200);
    }, 300);
}
// --- Selector de datasets ---
async function poblarSelectorTablas() {
    const select = document.getElementById("sel-tabla-activa");
    if (!select) return;  // null guard: el elemento puede no existir fuera del dashboard
    // [09/09] Si el selector ya fue sincronizado por base.html (opciones "imp-{id}"),
    // solo sincroniza la selección con el bloque activo, NO sobreescribe.
    if (select.options.length > 1 && select.options[1].value.startsWith("imp-")) {
        const params = new URLSearchParams(window.location.search);
        const bloqueActivo = params.get("id") || sessionStorage.getItem("zenit_dataset_activo");
        if (bloqueActivo) {
            const impId = Number(bloqueActivo);
            const opt = Array.from(select.options).find(o => {
                if (o.value.startsWith("imp-")) {
                    return Number(o.value.slice(4)) === impId;
                }
                return Number(o.value) === impId;
            });
            if (opt) select.value = opt.value;
        }
        return;
    }
    try {
        // [28/08] "Archivos" = solo el nombre del archivo importado (NO hojas).
        const res = await fetch("/api/importaciones");
        const importaciones = await res.json();
        select.innerHTML = '<option value="" disabled selected>— Selecciona un archivo —</option>';
        importaciones.forEach(imp => {
            const impId = imp.id ?? imp.importacion_id ?? "";
            const opt = document.createElement("option");
            opt.value = "imp-" + String(impId);
            opt.textContent = (imp.nombre_empresa || "Sin nombre") + (imp.fecha ? "  ·  " + String(imp.fecha).slice(0, 10) : "");
            select.appendChild(opt);
        });
    } catch (e) {
        select.innerHTML = '<option value="">Error al cargar archivos</option>';
    }
}

// ── Tab switching (llamado desde dashboard.html) ──────────────────────────
function switchTab(tabId, btn) {
    // Ocultar todos los paneles de tab (soporta ambas clases usadas en templates)
    document.querySelectorAll(".z-tab-content, .z-tab-panel").forEach(function(el) {
        el.classList.add("d-none");
    });
    // Desactivar todos los botones de tab
    document.querySelectorAll(".z-tab").forEach(function(t) {
        t.classList.remove("active");
    });
    // Mostrar el panel seleccionado
    const panel = document.getElementById(tabId);
    if (panel) panel.classList.remove("d-none");
    // [Fase 8] Redimensionar TODOS los charts visibles tras cambiar tab.
    // Sin esto, Chart.js dibuja en canvas con dimensiones 0 (tab oculto) y
    // al mostrar el tab las gráficas aparecen vacías.
    setTimeout(() => {
        Object.values(g._charts || {}).forEach(chart => {
            try { if (chart && chart.resize) chart.resize(); } catch (_) {}
        });
        // [Resumen-vs · 28/08] Blindaje: si algún canvas quedó con ÁREA 0
        // (se creó con el tab oculto y el resize no refrescó el buffer),
        // se RE-CREA desde la última config registrada por _crearChartTipo
        // (resumenChart, comparadorChart, dims dinámicas, etc.).
        if (typeof g._redibujarCanvas === "function") {
            Object.keys(g._charts || {}).forEach(id => {
                try {
                    const cv = document.getElementById(id);
                    if (cv && cv.offsetParent !== null &&
                        (cv.clientHeight === 0 || cv.clientWidth === 0)) {
                        g._redibujarCanvas(id);
                    }
                } catch (_) { /* canvas ausente: no bloquear el cambio de tab */ }
            });
        }
    }, 50);
    // Activar el boton de tab clickeado
    if (btn) btn.classList.add("active");
    // [Paso 5] re-renderizar la barra de módulos según la sección activa
    _tabActivoActual = tabId;
    renderizarBarraModulosPorTab(tabId);
}

// ── Cerrar modal de reconstruccion (llamado desde dashboard.html) ─────────
function cerrarModalReconstruir() {
    cerrarModal("modalReconstructNative");
}

// [Fix] Activa/desactiva el botón "Exportar PDF" de la barra lateral morada
// (#btn-exportar-pdf-nav) según haya dataset seleccionado. Antes quedaba
// permanentemente disabled (dependía de current_tabla_id del template Jinja).
function actualizarBtnPdfNav() {
    const btn = document.getElementById("btn-exportar-pdf-nav");
    if (!btn) return;
    const activo = Boolean(currentTablaId);
    btn.disabled = !activo;
    if (activo) {
        btn.style.opacity = "";
        btn.style.cursor = "";
    } else {
        btn.style.opacity = "0.4";
        btn.style.cursor = "not-allowed";
    }
}

async function cambiarDatasetActivo(id) {
    // [28/08] Si el value viene del selector de archivos ("imp-{importacion_id}"),
    // resolver el bloque principal de esa importación (tipo "detalle" o el
    // primero) y cargarlo como currentTablaId.
    if (String(id || "").startsWith("imp-")) {
        const impId = Number(String(id).slice(4));
        const bloquePrincipal = await _resolverBloquePrincipalDeImportacion(impId);
        if (!bloquePrincipal) {
            alert("No se pudo cargar el archivo seleccionado.");
            return;
        }
        id = bloquePrincipal;
    }
    currentTablaId = id;
    sessionStorage.setItem("zenit_dataset_activo", id);
    _ejeXActual = null;
    _ejeYActual = null;
    _metaActual = null;
    _ejesAutoSeleccionados = false;
    // [Frente C · E3] El mes filtrado era del dataset anterior — limpiar
    _filtroMesActual = null;
    sessionStorage.removeItem("zenit_filtro_mes");
    _filtroTipoActual = null;
    sessionStorage.removeItem("zenit_filtro_tipo");
    _filtroMesDesde = null;
    _filtroMesHasta = null;
    sessionStorage.removeItem("zenit_filtro_mes_desde");
    sessionStorage.removeItem("zenit_filtro_mes_hasta");
    // [09/09] Redirigir a la página actual (no siempre a /dashboard)
    const path = window.location.pathname;
    if (path.includes("/exportar")) {
        window.location.href = `/exportar?id=${id}`;
    } else if (path.includes("/import")) {
        window.location.href = `/import`;
    } else {
        history.pushState(null, "", `/dashboard?id=${id}`);
        ocultarBanner();
        poblarSelectorSecciones();
        actualizarBtnPdfNav();
        cargarDashboard(id);
    }
}

// [28/08] Resuelve el bloque principal (tipo "detalle") de una importación.
// [Fix 31/08] Contrato REAL de /api/importaciones (verificado en vivo):
//   {id, nombre_empresa, archivo, fecha, hojas:[{bloque_id, nombre_hoja,
//    nombre_tabla, mapeo_completo, dominio_detectado}]}
// El código anterior buscaba importacion_id/tipo_bloque (campos inexistentes)
// y devolvía null SIEMPRE → alert "No se pudo cargar el archivo seleccionado".
async function _resolverBloquePrincipalDeImportacion(impId) {
    try {
        const res = await fetch("/api/importaciones");
        const importaciones = await res.json();
        const imp = importaciones.find(i =>
            Number(i.id ?? i.importacion_id) === Number(impId));
        if (!imp || !imp.hojas || !imp.hojas.length) return null;
        // Preferir bloque tipo "detalle" (el principal de la matriz). El
        // endpoint no trae tipo_bloque: usa nombre_tabla ("Detalle" del
        // wizard) y cae a la primera hoja si no hay coincidencia.
        const detalle = imp.hojas.find(h =>
            String(h.tipo_bloque || "").toLowerCase() === "detalle" ||
            String(h.nombre_tabla || "").trim().toLowerCase() === "detalle");
        const principal = detalle || imp.hojas[0];
        return principal ? principal.bloque_id : null;
    } catch (e) {
        return null;
    }
}

// ── Selector de secciones / hojas (Fundacional §4.5) ─────────────────────────
// "Un archivo, un dashboard, múltiples secciones". Al cargar una importación,
// se listan sus hojas confirmadas en un dropdown para alternar entre secciones.
async function poblarSelectorSecciones() {
    const cont = document.getElementById("secciones-contenedor");
    const sel = document.getElementById("sel-seccion-activa");
    if (!cont || !sel || !currentTablaId) return;

    try {
        // Obtener la importación a la que pertenece el bloque actual
        const res = await fetch("/api/importaciones");
        const importaciones = await res.json();

        // Buscar el bloque actual en las importaciones
        let importacionActual = null;
        let hojasCoincidentes = [];
        for (const imp of importaciones) {
            const hojas = imp.hojas || [];
            if (hojas.some(h => h.bloque_id === Number(currentTablaId))) {
                importacionActual = imp;
                hojasCoincidentes = hojas;
                break;
            }
        }

        // Solo mostrar el selector si la importación tiene más de una hoja
        if (!importacionActual || hojasCoincidentes.length <= 1) {
            cont.style.display = "none";
            return;
        }

        // Poblar el selector con las hojas de la importación
        sel.innerHTML = '<option value="">— Selecciona una hoja —</option>';
        hojasCoincidentes.forEach(h => {
            const opt = document.createElement("option");
            opt.value = h.bloque_id;
            opt.textContent = h.nombre_hoja;
            sel.appendChild(opt);
        });
        sel.value = String(currentTablaId);
        cont.style.display = "flex";
    } catch (e) {
        console.error("Error poblando secciones:", e);
        cont.style.display = "none";
    }
}

function cambiarSeccionActiva(bloqueId) {
    if (!bloqueId) return;
    cambiarDatasetActivo(Number(bloqueId));
}

// ── [Frente C · E3] Filtros financieros globales (réplica del B2 Excel) ──
function poblarFiltrosFinancieros(data) {
    const selMes = document.getElementById("sel-filtro-mes");
    const barra = document.getElementById("barra-filtros-financieros");
    if (!selMes || !barra) return;
    const biz = data.business || {};
    const tieneFin = biz.total_ingresos !== undefined || biz.total_egresos !== undefined;
    if (!tieneFin) { barra.style.display = "none"; return; }
    barra.style.display = "flex";
    // [Resumen-vs · 28/08] El selector de mes usa los PERIODOS del backend
    // (clave ISO "2026-01" + label "Enero 2026"; o clave "enero" en bloques
    // solo-Mes): así "Enero 2025" y "Enero 2026" son opciones separadas y el
    // backend filtra por mes-año vía _mascara_periodo.
    const serieI = biz._serie_mensual_ingresos;
    const meses = serieI ? serieI.labels : [];
    const periodosSel = (Array.isArray(biz.periodos) && biz.periodos.length)
        ? biz.periodos
        : meses.map(m => ({ clave: String(m).toLowerCase(), label: m }));
    const actual = String(_filtroMesActual || "").toLowerCase();
    // [Resumen-vs · 28/08] Si la clave guardada ya no existe en los periodos
    // del dataset actual (cambio de dataset, o clave de formato anterior,
    // p. ej. "Enero" en un bloque que ahora trae "2026-01"), se resetea:
    // evita un filtro activo sin ninguna opción marcada en el selector.
    if (actual && !periodosSel.some(p => String(p.clave || "").toLowerCase() === actual)) {
        _filtroMesActual = null;
        try { sessionStorage.setItem("zenit_filtro_mes", ""); } catch (_) {}
    }
    selMes.innerHTML = '<option value="">Todos los meses</option>' + periodosSel.map(p => {
        const sel = String(p.clave || "").toLowerCase() === actual ? " selected" : "";
        return `<option value="${p.clave}"${sel}>${p.label || p.clave}</option>`;
    }).join("");
    const selTipo = document.getElementById("sel-filtro-tipo");
    if (selTipo) selTipo.value = _filtroTipoActual || "";

    // [Plan F · 23/08] Selectores "Desde/Hasta" (Rango de la Tendencia).
    // `biz.periodos` trae {clave:"2026-03", label:"Marzo 2026"} cronológico.
    const periodos = (Array.isArray(biz.periodos) && biz.periodos.length)
        ? biz.periodos
        : meses.map(m => ({ clave: String(m).toLowerCase(), label: m }));
    // [Fase 4] Calendario nativo: restaurar valores guardados en los inputs date.
    const inpD = document.getElementById("fecha-desde");
    const inpH = document.getElementById("fecha-hasta");
    if (inpD && _filtroFechaDesde) inpD.value = _filtroFechaDesde;
    if (inpH && _filtroFechaHasta) inpH.value = _filtroFechaHasta;
}

function cambiarFiltroMes(valor) {
    _filtroMesActual = valor || null;
    sessionStorage.setItem("zenit_filtro_mes", _filtroMesActual || "");
    if (currentTablaId) {
        cargarDashboard(currentTablaId);
        // [Frente C] La grilla de Registros también respeta el filtro global
        cargarGridRegistros(currentTablaId);
    }
}

function cambiarFiltroTipo(valor) {
    _filtroTipoActual = valor || null;
    sessionStorage.setItem("zenit_filtro_tipo", _filtroTipoActual || "");
    if (currentTablaId) {
        cargarDashboard(currentTablaId);
        if (typeof cargarGridRegistros === "function") cargarGridRegistros(currentTablaId);
    }
}

// [Fase 4] Calendario nativo Desde/Hasta: fechas reales día a día (uno o
    // varios meses). El backend convierte a claves de período según el tipo de
    // columna calendario (Fecha real -> ISO; Mes textual -> ordinal _MES_NUM).
    function cambiarFiltroFechas() {
        const d = document.getElementById("fecha-desde");
        const h = document.getElementById("fecha-hasta");
        if (!d || !h) return;
        if (d.value && h.value && d.value > h.value) { h.value = d.value; }
        _filtroFechaDesde = d.value || null;
        _filtroFechaHasta = h.value || null;
        sessionStorage.setItem("zenit_fecha_desde", _filtroFechaDesde || "");
        sessionStorage.setItem("zenit_fecha_hasta", _filtroFechaHasta || "");
        if (currentTablaId) {
            cargarDashboard(currentTablaId);
            if (typeof cargarGridRegistros === "function") cargarGridRegistros(currentTablaId);
        }
    }
    function limpiarFiltroFechas() {
        _filtroFechaDesde = null;
        _filtroFechaHasta = null;
        sessionStorage.setItem("zenit_fecha_desde", "");
        sessionStorage.setItem("zenit_fecha_hasta", "");
        const d = document.getElementById("fecha-desde");
        const h = document.getElementById("fecha-hasta");
        if (d) d.value = "";
        if (h) h.value = "";
        if (currentTablaId) cargarDashboard(currentTablaId);
    }

// [Frente C · E5+] Renderiza las tarjetas financieras principales (réplica del
// dashboard B2:H8 del Excel) y los resúmenes I/E lado a lado. Cuando hay
// datos financieros, el KPI-grid genérico se oculta para no duplicar.
function renderizarFinPrincipal(biz) {
    const grid = document.getElementById("z-fin-grid");
    // [T-1 · 31/08] Fila de volumen (Consultas · Cirugías) separada de la fila
    // de dinero. dosCol fue eliminado del HTML (tablas I/E -> solo Análisis).
    const volGrid = document.getElementById("z-fin-grid-vol");
    const kpiGen = document.getElementById("kpi-grid-generico");
    if (!grid) return;

    // [Fase dedup] Respetar series globales apagadas (__ingresos/__egresos):
    // ocultar SOLO la tarjeta del lado apagado; Saldo/Margen% requieren ambos.
    const ingOff = _modulosVisiblesActual["__ingresos"] === false;
    const egrOff = _modulosVisiblesActual["__egresos"] === false;
    const cIng = grid.querySelector(".z-fin-card.ingresos");
    const cEgr = grid.querySelector(".z-fin-card.egresos");
    if (cIng) cIng.classList.toggle("d-none", ingOff);
    if (cEgr) cEgr.classList.toggle("d-none", egrOff);
    grid.querySelectorAll(".z-fin-card:not(.ingresos):not(.egresos)")
        .forEach(c => c.classList.toggle("d-none", ingOff || egrOff));
    const mo = biz && biz.metricas_operativas ? biz.metricas_operativas : {};
    const tieneVol = mo.n_consultas !== undefined || mo.n_cirugias !== undefined;
    const tiene = biz && biz.total_ingresos !== undefined;
    if (!tiene) {
        grid.classList.add("d-none");
        if (volGrid) volGrid.classList.toggle("d-none", !tieneVol);
        if (kpiGen) kpiGen.classList.remove("d-none");
        return;
    }
    grid.classList.remove("d-none");
    if (volGrid) volGrid.classList.toggle("d-none", !tieneVol);
    if (kpiGen) kpiGen.classList.add("d-none");

    const ing = biz.total_ingresos || 0;
    const egr = biz.total_egresos || 0;
    const saldo = biz.margen_neto || 0;
    const pct = ing > 0 ? ((saldo / ing) * 100).toFixed(1) : "0.0";

    // [T-1 · 31/08] KPIs Consultas · Cirugías — mo ya declarado arriba (L460).
    setFinText("fin-val-consultas", String(mo.n_consultas !== undefined ? mo.n_consultas : "—"));
    setFinText("fin-val-cirugias", String(mo.n_cirugias !== undefined ? mo.n_cirugias : "—"));
    // [P-2 · 31/08] Ticket promedio en la fila de volumen.
    const ticketProm = (biz && biz.ticket_promedio != null) ? biz.ticket_promedio : null;
    const nOps = (biz && biz.n_operaciones != null) ? biz.n_operaciones : null;
    setFinText("fin-sub-consultas", mo.n_consultas !== undefined ? `${mo.n_consultas || 0} ops${ticketProm != null ? ` · prom ${formatearMoneda(ticketProm)}` : ""}` : "operaciones");
    setFinText("fin-sub-cirugias", mo.n_cirugias !== undefined ? `${mo.n_cirugias || 0} ops${nOps != null ? ` de ${nOps}` : ""}` : "operaciones");

    setFinText("fin-val-ingresos", formatearMoneda(ing));
    // [P-1 · 31/08] Δ% en cada KPI card individual (vs_mes_anterior extendido).
    const vs = biz.vs_mes_anterior;
    const varIng = vs && vs.var_ingreso_pct != null;
    const varEgr = vs && vs.var_egreso_pct != null;
    if (varIng) {
      const fi = vs.var_ingreso_pct >= 0 ? "▲" : "▼";
      const ci = vs.var_ingreso_pct >= 0 ? "#059669" : "#dc2626";
      setFinText("fin-sub-ingresos", `${biz.n_ingresos || 0} ops · <span style="color:${ci}">${fi} ${Math.abs(vs.var_ingreso_pct)}% vs ${vs.mes_anterior}</span>`);
    } else {
      setFinText("fin-sub-ingresos", `${biz.n_ingresos || 0} operaciones`);
    }
    setFinText("fin-val-egresos", formatearMoneda(egr));
    if (varEgr) {
      const fe = vs.var_egreso_pct >= 0 ? "▲" : "▼";
      const ce = vs.var_egreso_pct >= 0 ? "#dc2626" : "#059669";
      setFinText("fin-sub-egresos", `${biz.n_egresos || 0} ops · <span style="color:${ce}">${fe} ${Math.abs(vs.var_egreso_pct)}% vs ${vs.mes_anterior}</span>`);
    } else {
      setFinText("fin-sub-egresos", `${biz.n_egresos || 0} egresos`);
    }
    // [T-1] Margen $ + Δ% vs mes anterior
    setFinText("fin-val-margen", formatearMoneda(saldo));
    if (vs && vs.mes_anterior) {
        const flecha = vs.variacion_pct >= 0 ? "▲" : "▼";
        const color = vs.variacion_pct >= 0 ? "#059669" : "#dc2626";
        setFinText("fin-sub-margen",
            `${pct}% del ingreso · <span style="color:${color}">${flecha} ${Math.abs(vs.variacion_pct)}% vs ${vs.mes_anterior}</span>`);
    } else {
        setFinText("fin-sub-margen", `${pct}% del ingreso total`);
    }
    // Margen % + Δpp (puntos porcentuales, no % del %)
    const deltaPp = vs && vs.delta_pp != null ? vs.delta_pp : null;
    setFinText("fin-val-margenpct", (ing > 0 ? ((saldo / ing) * 100).toFixed(1) : "0.0") + "%");
    if (deltaPp !== null && vs && vs.mes_anterior) {
        const fpp = deltaPp >= 0 ? "▲" : "▼";
        const cpp = deltaPp >= 0 ? "#059669" : "#dc2626";
        setFinText("fin-sub-margenpct", `${pct}% del ingreso · <span style="color:${cpp}">${fpp} ${Math.abs(deltaPp)}pp vs ${vs.mes_anterior}</span>`);
    } else {
        setFinText("fin-sub-margenpct", `margen / ingresos totales`);
    }
    // resúmenes I/E lado a lado: [T-1 31/08] ya NO se muestran en el Resumen
    // (Resumen = solo BI; las tablas viven en Análisis vía adv-dos-col). Las
    // funciones pintarTablaResumen siguen disponibles para quien las use.
}

function setFinText(id, val) {
    const el = document.getElementById(id);
    // innerHTML permite el span coloreado de variación "▲ +21.9% vs Febrero".
    // Los valores provienen de data.business (backend propio, sin input libre
    // del usuario) — riesgo XSS nulo.
    if (el) el.innerHTML = val;
}

// [T-1 · 31/08] Semáforo "¿vamos bien este mes?" — lee kpis.meta/porcentaje_meta
// (el backend los calcula cuando hay meta configurada; business/kpis ya vienen
// filtrados por mes/año/totalidad). Verde si ≥100%, ámbar si ≥80%, rojo si no.
function renderizarSemaforoMeta(kpis) {
    const wrap = document.getElementById("wrap-semaforo-meta");
    const texto = document.getElementById("semaforo-meta-texto");
    const sub = document.getElementById("semaforo-meta-sub");
    if (!wrap || !texto) return;
    const meta = kpis && kpis.meta;
    const pct = kpis && kpis.porcentaje_meta;
    if (meta === undefined || meta === null || !meta || pct === undefined || pct === null) {
        wrap.classList.add("d-none");
        return;
    }
    wrap.classList.remove("d-none");
    const p = Number(pct) || 0;
    const icono = p >= 100 ? "✅" : (p >= 80 ? "🟡" : "⚠️");
    const color = p >= 100 ? "#16A34A" : (p >= 80 ? "#D97706" : "#DC2626");
    const periodo = _filtroMesActual
        ? (String(_filtroMesActual).charAt(0).toUpperCase() + String(_filtroMesActual).slice(1))
        : "el período";
    texto.innerHTML =
        `<span style="font-size:15px">${icono}</span> ` +
        `<b style="color:${color}">${p.toFixed(1)}% de la meta</b> en ${periodo} ` +
        `(objetivo: ${formatearMoneda(meta)} · actual: ${formatearMoneda(kpis.suma || 0)}). ` +
        (p >= 100 ? "¡Vas bien!" : (p >= 80 ? "Vas cerca — empuja un poco más." : "Por debajo de la meta: revisa egresos o impulsa ingresos."));
    if (sub) sub.textContent = "basado en la meta configurada";
}

// [T-1 · 31/08] Top 5 por margen — resumen BI compacto (no la lista completa).
// Fuente: business.margen_por_entidad (pacientes) o margen_por_procedimiento;
// prioriza pacientes si existen. business ya viene filtrado por mes/año.
function renderizarTop5(biz) {
    const wrap = document.getElementById("wrap-top5");
    const cont = document.getElementById("top5-contenido");
    const sub = document.getElementById("top5-sub");
    if (!wrap || !cont) return;
    const mp = (biz && biz.margen_por_entidad) || {};
    const mpp = (biz && biz.margen_por_procedimiento) || {};
    const entsPac = (mp && mp.entidades) || [];
    const entsProc = (mpp && mpp.entidades) || [];
    let fuente = null, etiqueta = "";
    if (entsPac.length) { fuente = entsPac; etiqueta = "Pacientes"; }
    else if (entsProc.length) { fuente = entsProc; etiqueta = "Procedimientos"; }
    if (!fuente || !fuente.length) {
        wrap.classList.add("d-none");
        return;
    }
    wrap.classList.remove("d-none");
    const top5 = fuente
        .slice()
        .sort((a, b) => (b.utilidad || 0) - (a.utilidad || 0))
        .slice(0, 5);
    const totalFuente = fuente.reduce((s, e) => s + (e.utilidad || 0), 0) || 0;
    if (sub) sub.textContent = `${etiqueta} · ${fuente.length} en total`;
    cont.innerHTML = top5.map((e, i) => {
        const pctConc = totalFuente > 0 ? ((e.utilidad || 0) / totalFuente * 100).toFixed(0) : 0;
        const color = i === 0 ? "var(--zp-600)" : "var(--zn-700)";
        return '<div style="flex:1 1 130px;min-width:120px;background:var(--zn-50);' +
               'border:1px solid var(--zn-200);border-radius:10px;padding:8px 10px">' +
               '<div style="font-size:10px;color:var(--zn-400);text-transform:uppercase;letter-spacing:.04em">' +
               '#' + (i + 1) + ' · ' + pctConc + '% del margen</div>' +
               '<div style="font-size:12px;font-weight:700;color:' + color + ';margin-top:2px;' +
               'white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + String(e.entidad || "").replace(/"/g, "&quot;") + '">' +
               String(e.entidad || "—").slice(0, 22) + '</div>' +
               '<div style="font-size:12px;font-weight:600;color:var(--zx-ingresos)">' + formatearMoneda(e.utilidad || 0) + '</div>' +
               '<div style="font-size:10px;color:var(--zn-500)">margen ' + (e.margen_pct != null ? e.margen_pct + "%" : "—") + '</div>' +
               '</div>';
    }).join("");
}

// ─── [P-3 · P-6 · P-2 · P-5] Nuevos componentes del Resumen BI ──────────────

// [P-3] Benchmark: muestra Δpp vs promedio histórico de los últimos N períodos.
function renderizarBenchmarkMargen(biz) {
    const bench = (biz && biz.benchmark_margen) || null;
    if (!bench || bench.promedio === undefined || bench.promedio === null) return;
    const sub = document.getElementById("fin-sub-margenpct");
    if (!sub) return;
    const ing = biz.total_ingresos || 0;
    const saldo = biz.margen_neto || 0;
    const pctActual = ing > 0 ? ((saldo / ing) * 100) : 0;
    const dpp = Math.round((pctActual - bench.promedio) * 10) / 10;
    const fi = dpp >= 0 ? "▲" : "▼";
    const col = dpp >= 0 ? "#059669" : "#DC2626";
    // Aditivo: APPENDE al subtítulo existente (Δpp vs mes anterior), NO sobrescribe.
    sub.innerHTML += ` · <span style="color:${col}">${fi} ${Math.abs(dpp)}pp vs prom ${bench.n_periodos}m</span>`;
}

// [P-6] Badge de estado en el header del tab Resumen.
function renderizarBadgeHeader(data) {
    const wrap = document.getElementById("resumen-header-badge");
    const peri = document.getElementById("resumen-header-periodo");
    const estado = document.getElementById("resumen-header-estado");
    if (!wrap || !peri || !estado) return;
    const kpis = data && data.kpis;
    const biz = data && data.business;
    const meta = kpis && kpis.meta;
    const pctMeta = kpis && kpis.porcentaje_meta;
    let texto = "", bgColor = "";
    if (meta && pctMeta != null) {
        texto = pctMeta >= 100 ? "🟢 En meta" : (pctMeta >= 80 ? "🟡 Cerca de meta" : "🔴 Por debajo de meta");
        bgColor = pctMeta >= 100 ? "#16A34A" : (pctMeta >= 80 ? "#D97706" : "#DC2626");
    } else {
        const bench = (biz && biz.benchmark_margen) || null;
        const ma = data && data.margen_automatico;
        const saldo = (ma && ma.margen) ?? (biz && biz.margen_neto);
        const ingresos = (ma && ma.ingresos) ?? (biz && biz.total_ingresos);
        if (bench && bench.promedio && ingresos > 0 && saldo !== undefined) {
            const pct = Math.round((saldo / ingresos) * 100);
            const dpp = Math.round((pct - bench.promedio) * 10) / 10;
            texto = dpp >= 0 ? "🟢 Sobre promedio" : "🔴 Bajo promedio";
            bgColor = dpp >= 0 ? "#16A34A" : "#DC2626";
        } else { wrap.classList.add("d-none"); return; }
    }
    let periodo = "—";
    if (_filtroMesActual) {
        periodo = _filtroMesActual.charAt(0).toUpperCase() + _filtroMesActual.slice(1);
    } else {
        const pers = (biz && biz.periodos) || [];
        if (pers.length) periodo = pers[pers.length - 1].label || String(pers[pers.length - 1].clave);
    }
    wrap.classList.remove("d-none");
    peri.textContent = periodo;
    estado.textContent = texto;
    estado.style.background = bgColor;
    estado.style.color = "#fff";
}

// [P-2] Ticket promedio strip (bajo el header, compacto).
function renderizarTicketStrip(biz) {
    const strip = document.getElementById("resumen-ticket-strip");
    if (!strip) return;
    const ticket = biz && biz.ticket_promedio;
    if (ticket == null) { strip.classList.add("d-none"); return; }
    strip.classList.remove("d-none");
    const cats = (biz.ingresos_por_categoria || []).filter(i => {
        const v = String(i.categoria || "").toLowerCase();
        return v.includes("cirug") || v.includes("consult");
    });
    let tConsulta = null, tCirugia = null;
    cats.forEach(c => {
        const v = String(c.categoria || "").toLowerCase();
        if (v.includes("consult") && c.conteo) tConsulta = Math.round(c.monto / c.conteo);
        if (v.includes("cirug") && c.conteo) tCirugia = Math.round(c.monto / c.conteo);
    });
    document.getElementById("ticket-prom-total").textContent =
        `Ticket promedio: ${formatearMoneda(ticket)}`;
    document.getElementById("ticket-prom-consulta").textContent =
        tConsulta != null ? `Ticket consulta: ${formatearMoneda(tConsulta)}` : "";
    document.getElementById("ticket-prom-cirugia").textContent =
        tCirugia != null ? `Ticket cirugía: ${formatearMoneda(tCirugia)}` : "";
}

// [P-5] Donut "Ingresos: Cirugías vs Consultas" — composición alta.
function renderizarDonutConsultasCirugias(biz) {
    const wrap = document.getElementById("wrap-donut-consultas");
    if (!wrap) return;
    const cats = (biz && biz.ingresos_por_categoria) || [];
    let ingCir = 0, ingCons = 0;
    cats.forEach(c => {
        const v = String(c.categoria || "").toLowerCase();
        if (v.includes("cirug")) ingCir += (c.monto || 0);
        if (v.includes("consult")) ingCons += (c.monto || 0);
    });
    if (ingCir === 0 && ingCons === 0) { wrap.classList.add("d-none"); return; }
    wrap.classList.remove("d-none");
    _destruirChart("chartConsultasCirugias");
    new Chart(document.getElementById("chartConsultasCirugias"), {
        type: "doughnut",
        data: {
            labels: ["Cirugías", "Consultas"],
            datasets: [{
                data: [ingCir, ingCons],
                backgroundColor: ["#5B0672", "#7C3AED"],
                borderWidth: 2, borderColor: "#fff",
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: "bottom", labels: { font: { size: 11 } } },
                tooltip: { callbacks: {
                    label: ctx => `${ctx.label}: ${formatearMoneda(ctx.raw)} (${((ctx.raw / (ingCir + ingCons)) * 100).toFixed(1)}%)`,
                }},
            },
        },
    });
}

// [P-4] Sparklines: mini línea dentro de cada KPI card de dinero.
function dibujarSparklines(biz) {
    if (!biz || !biz._serie_mensual_ingresos) return;
    const mapeo = [
        { canvas: "spark-ingresos", serie: biz._serie_mensual_ingresos },
        { canvas: "spark-egresos",  serie: biz._serie_mensual_egresos },
        { canvas: "spark-margen",   serie: biz._serie_mensual_margen },
    ];
    mapeo.forEach(m => {
        const cv = document.getElementById(m.canvas);
        if (!cv || !m.serie || !m.serie.valores || m.serie.valores.length < 2) return;
        _destruirChart(m.canvas);
        new Chart(cv, {
            type: "line",
            data: {
                labels: m.serie.labels || m.serie.valores.map((_, i) => String(i + 1)),
                datasets: [{
                    data: m.serie.valores.map(Number),
                    borderColor: "var(--zp-600)",
                    borderWidth: 2, pointRadius: 0, tension: 0.3,
                }],
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
                scales: { x: { display: false }, y: { display: false } },
            },
        });
    });
}

// [P-12b · 09/09] INGRESOS VS EGRESOS POR CATEGORÍA (barras agrupadas).
function renderizarIECategoria(biz) {
    const wrap = document.getElementById("wrap-ie-categoria");
    const cv = document.getElementById("chartIECategoria");
    if (!wrap || !cv) return;
    const ing = (biz && biz.ingresos_por_categoria) || [];
    const egr = (biz && biz.egresos_por_categoria) || [];
    if (!ing.length && !egr.length) { wrap.classList.add("d-none"); return; }
    // Unir las claves de ambas listas (categorías presentes en I o E).
    const mapaI = {}, mapaE = {};
    ing.forEach(c => { mapaI[c.categoria] = c.monto || 0; });
    egr.forEach(c => { mapaE[c.categoria] = c.monto || 0; });
    let claves = Object.keys(Object.assign({}, mapaI, mapaE));
    if (!claves.length) { wrap.classList.add("d-none"); return; }

    // [Fix · 09/09] Adaptación a N datos: el Excel puede traer 2 o 50 categorías.
    // Se consolidan las más pequeñas en "Otros" para que las barras sean legibles
    // siempre (mismo principio que las donas de composición).
    const MAX_CATS = 10;
    if (claves.length > MAX_CATS) {
        const ordenadas = claves.slice().sort(
            (a, b) => ((mapaI[b] || 0) + (mapaE[b] || 0)) - ((mapaI[a] || 0) + (mapaE[a] || 0)),
        );
        const top = ordenadas.slice(0, MAX_CATS - 1);
        const restoI = ordenadas.slice(MAX_CATS - 1).reduce((s, k) => s + (mapaI[k] || 0), 0);
        const restoE = ordenadas.slice(MAX_CATS - 1).reduce((s, k) => s + (mapaE[k] || 0), 0);
        mapaI["Otros"] = restoI;
        mapaE["Otros"] = restoE;
        claves = top.concat("Otros");
    }
    wrap.classList.remove("d-none");
    _destruirChart("chartIECategoria");
    new Chart(cv, {
        type: "bar",
        data: {
            labels: claves.map(k => String(k).slice(0, 22)),
            datasets: [
                { label: "Ingresos", data: claves.map(k => mapaI[k] || 0), backgroundColor: "#059669", borderWidth: 0 },
                { label: "Egresos", data: claves.map(k => mapaE[k] || 0), backgroundColor: "#DC2626", borderWidth: 0 },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: "bottom", labels: { font: { size: 10 } } },
                tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${formatearMoneda(ctx.raw)}` } },
            },
            scales: {
                x: { grid: { display: false }, ticks: { font: { size: 9 } } },
                y: { ticks: { font: { size: 9 }, callback: v => formatearNum(v, 0) } },
            },
        },
    });
}

// [P-10 · 09/09] HEATMAP DE ESTACIONALIDAD: mes × métrica con intensidad relativa.
function renderizarHeatmap(biz) {
    const wrap = document.getElementById("wrap-heatmap");
    const cont = document.getElementById("heatmap-contenido");
    if (!wrap || !cont) return;
    const tm = (biz && biz.tabla_mensual) || {};
    const filas = (tm.filas || []).filter(f => f.mes);
    if (filas.length < 2) { wrap.classList.add("d-none"); return; }
    wrap.classList.remove("d-none");
    // Métricas: [etiqueta, clave, es_monto, es_pct]
    const metrics = [
        { label: "Ingresos", key: "ingresos", fmt: "money" },
        { label: "Egresos", key: "egresos", fmt: "money" },
        { label: "Margen", key: "margen", fmt: "money" },
        { label: "Margen %", key: "margen_pct", fmt: "pct" },
        { label: "Consultas", key: "consultas", fmt: "num" },
        { label: "Cirugías", key: "cirugias", fmt: "num" },
    ];
    function _fmt(v, fmt) {
        if (v === null || v === undefined) return "—";
        if (fmt === "money") return formatearNum(v, 0);
        if (fmt === "pct") return v.toFixed(0) + "%";
        return String(Math.round(v));
    }
    // Color: intensidad morado según valor relativo al máximo de la métrica.
    function _color(v, max) {
        if (max <= 0) return "transparent";
        const ratio = Math.min(Math.abs(v) / max, 1);
        if (ratio < 0.05) return "var(--zn-50)";
        const alpha = Math.round(ratio * 220 + 35); // 35..255
        return `rgba(91,6,114,${(alpha / 255).toFixed(2)})`;
    }
    let html = '<div style="overflow:auto;max-height:420px"><table style="width:100%;border-collapse:collapse;font-size:11px">';
    html += '<thead><tr><th style="text-align:left;padding:4px 6px;border-bottom:1px solid var(--zn-200);position:sticky;top:0;background:#fff">Mes</th>';
    metrics.forEach(m => {
        html += `<th style="text-align:center;padding:4px 6px;border-bottom:1px solid var(--zn-200);position:sticky;top:0;background:#fff;font-weight:600">${m.label}</th>`;
    });
    html += "</tr></thead><tbody>";
    filas.forEach(f => {
        html += `<tr><td style="padding:4px 6px;font-weight:600;white-space:nowrap">${String(f.mes).slice(0, 18)}</td>`;
        metrics.forEach(m => {
            const v = Number(f[m.key]);
            const max = Math.max(...filas.map(x => Math.abs(Number(x[m.key]) || 0)));
            const bg = _color(v, max);
            const txtColor = (v != null && max > 0 && Math.abs(v) / max > 0.6) ? "#fff" : "inherit";
            html += `<td style="text-align:center;padding:4px 6px;background:${bg};color:${txtColor};border-radius:3px">${_fmt(v, m.fmt)}</td>`;
        });
        html += "</tr>";
    });
    html += "</tbody></table></div>";
    cont.innerHTML = html;
}

// [P-9 · 31/08] FLUJO DE CAJA ACUMULADO: cumsum de `_serie_mensual_margen`.
function renderizarFlujoCaja(biz) {
    const wrap = document.getElementById("wrap-flujo-caja");
    const cv = document.getElementById("chartFlujoCaja");
    if (!wrap || !cv) return;
    const serie = biz && biz._serie_mensual_margen;
    if (!serie || !serie.valores || serie.valores.length < 2) { wrap.classList.add("d-none"); return; }
    const labels = serie.labels || serie.valores.map((_, i) => String(i + 1));
    const acum = [];
    let suma = 0;
    serie.valores.forEach(v => { suma += Number(v) || 0; acum.push(Math.round(suma * 100) / 100); });
    wrap.classList.remove("d-none");
    _destruirChart("chartFlujoCaja");
    new Chart(cv, {
        type: "line",
        data: {
            labels,
            datasets: [{
                label: "Margen acumulado",
                data: acum,
                borderColor: "#5B0672",
                backgroundColor: "rgba(91,6,114,0.08)",
                borderWidth: 2, pointRadius: 3, tension: 0.3, fill: true,
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => `Acumulado: ${formatearMoneda(ctx.raw)}` } },
            },
            scales: {
                x: { grid: { display: false }, ticks: { font: { size: 9 } } },
                y: { ticks: { font: { size: 9 }, callback: v => formatearNum(v) } },
            },
        },
    });
}

// [G-FASE 3 · 09/09] PANEL COMPAÑERO DE TENDENCIA: Mejor mes / Peor mes.
// Reutiliza business.tabla_mensual.filas (la MISMA serie que alimenta
// Tendencia) — solo max()/min() sobre margen. Sin endpoint nuevo en backend.
// Se recalcula automáticamente porque actualizarUI re-renderiza el Resumen
// ante cualquier cambio de filtro de mes/año (mismo principio que Tendencia).
function renderizarMejorPeorMes(biz) {
    const wrap = document.getElementById("wrap-mejor-peor-mes");
    if (!wrap) return;
    const tm = (biz && biz.tabla_mensual) || {};
    const filas = (tm.filas || []).filter(f => f && f.mes && f.margen !== null && f.margen !== undefined);
    if (filas.length < 1) { wrap.classList.add("d-none"); return; }
    wrap.classList.remove("d-none");

    let mejor = filas[0];
    let peor = filas[0];
    filas.forEach(f => {
        if (Number(f.margen) > Number(mejor.margen)) mejor = f;
        if (Number(f.margen) < Number(peor.margen)) peor = f;
    });

    const elMejorValor = document.getElementById("mejor-mes-valor");
    const elMejorSub = document.getElementById("mejor-mes-sub");
    const elPeorValor = document.getElementById("peor-mes-valor");
    const elPeorSub = document.getElementById("peor-mes-sub");

    if (elMejorValor) elMejorValor.textContent = formatearMoneda(mejor.margen);
    if (elMejorSub) elMejorSub.textContent = String(mejor.mes || "—");
    if (elPeorValor) elPeorValor.textContent = formatearMoneda(peor.margen);
    if (elPeorSub) elPeorSub.textContent = String(peor.mes || "—");
}

// [P-11 · 31/08] FRASES DE INSIGHTS EXTENDIDAS: concentración, racha, benchmark
// y extremos. Mismo estilo que las otras cards: texto plano sin HTML inline.
function renderizarInsightsExtendidos(biz) {
    const wrap = document.getElementById("insights-extendidos");
    if (!wrap) return;
    const frases = [];
    const ents = ((biz.margen_por_entidad || {}).entidades) || [];
    if (ents.length >= 3) {
        const sorted = ents.slice().sort((a, b) => (b.utilidad || 0) - (a.utilidad || 0));
        const totalUtil = ents.reduce((s, e) => s + (e.utilidad || 0), 0);
        if (totalUtil > 0) {
            let acu = 0, n = 0;
            for (const e of sorted) { acu += (e.utilidad || 0); n++; if (acu / totalUtil >= 0.6) break; }
            if (n <= 5) frases.push(`⚠️ Concentración: ${n} ${n === 1 ? "paciente" : "pacientes"} generan ${Math.round(acu / totalUtil * 100)}% del margen.`);
        }
    }
    const serie = biz._serie_mensual_margen;
    if (serie && serie.valores && serie.valores.length >= 3) {
        const v = serie.valores.map(Number);
        let racha = 0, dir = 0;
        for (let i = 1; i < v.length; i++) {
            const d = v[i] - v[i - 1];
            if (d === 0) continue;
            if (dir === 0) { dir = d > 0 ? 1 : -1; racha = 1; }
            else if ((d > 0) === (dir > 0)) racha++;
            else break;
        }
        if (racha >= 3) {
            const palabra = dir > 0 ? "al alza" : "a la baja";
            frases.push(`📉 Racha: ${racha} meses consecutivos ${palabra} en margen.`);
        }
    }
    const bench = biz.benchmark_margen;
    if (bench && bench.promedio) {
        const tm = biz.tabla_mensual;
        const filas = (tm && tm.filas) || [];
        if (filas.length >= 2) {
            const ult = filas[filas.length - 1];
            const pctUlt = ult.margen_pct;
            if (pctUlt != null) {
                const dpp = Math.round((pctUlt - bench.promedio) * 10) / 10;
                const fi = dpp >= 0 ? "▲" : "▼";
                frases.push(`📊 Benchmark: el margen % de ${ult.mes || "este mes"} está ${fi} ${Math.abs(dpp)}pp vs tu promedio de ${bench.n_periodos} meses (${bench.promedio.toFixed(1)}%).`);
            }
        }
    }
    if (ents.length >= 2) {
        const sortedExt = ents.slice().sort((a, b) => (b.utilidad || 0) - (a.utilidad || 0));
        const mejor = sortedExt[0];
        const peor = sortedExt[sortedExt.length - 1];
        if (mejor && (mejor.utilidad || 0) > 0) {
            const mp = mejor.margen_pct != null ? `, margen ${mejor.margen_pct}%` : "";
            frases.push(`⭐ Mejor: ${String(mejor.entidad || "—").slice(0, 24)} con ${formatearMoneda(mejor.utilidad || 0)}${mp}.`);
        }
        if (peor && (peor.utilidad || 0) < 0) {
            frases.push(`🔻 Peor: ${String(peor.entidad || "—").slice(0, 24)} con ${formatearMoneda(peor.utilidad || 0)} — revisa sus costos.`);
        }
    }
    if (!frases.length) { wrap.classList.add("d-none"); return; }
    wrap.classList.remove("d-none");
    wrap.innerHTML = frases.map(f => `<div style="padding:8px 14px;font-size:12.5px;color:var(--zn-800);line-height:1.6">${f}</div>`).join("");
}

function pintarTablaResumen(tablaId, items, tipoEsperado, totalRef) {
    const tbl = document.getElementById(tablaId);
    if (!tbl) return;
    const moneda = _monedaActual + " ";
    let html = '<thead><tr><th>Categor\u00eda</th><th class="num">Reg.</th><th class="num">Monto</th></tr></thead><tbody>';
    let suma = 0, conteo = 0;
    (items || []).forEach(it => {
        html += `<tr><td>${String(it.categoria).slice(0, 32)}</td>` +
                `<td class="num">${it.conteo || 0}</td>` +
                `<td class="num">${moneda}${formatearNum(it.monto || 0)}</td></tr>`;
        suma += it.monto || 0; conteo += it.conteo || 0;
    });
    html += `</tbody><tfoot><tr><td>Total</td><td class="num">${conteo}</td>` +
            `<td class="num">${moneda}${formatearNum(suma)}</td></tr></tfoot>`;
    tbl.innerHTML = html;
}

// [Frente C · F2.5] Renderiza el desglose automático por Concepto (jerárquico
// Categoría→Concepto). Cada fila = concepto con Ingresos/Egresos. Se agrupa
// visualmente por categoría.
function renderizarDesgloseConcepto(modulosDerivados) {
    const wrap = document.getElementById("wrap-desglose-concepto");
    const tbl = document.getElementById("tabla-desglose-concepto");
    if (!wrap || !tbl) return;
    const items = (modulosDerivados && modulosDerivados.por_concepto) || [];
    if (!items.length) { wrap.classList.add("d-none"); return; }
    wrap.classList.remove("d-none");
    let html = '<thead><tr><th>Categor\u00eda</th><th>Concepto</th><th class="num">Ingresos</th><th class="num">Egresos</th></tr></thead><tbody>';
    let tIng = 0, tEgr = 0;
    items.forEach(it => {
        html += `<tr><td>${String(it.categoria).slice(0, 30)}</td>` +
                `<td>${String(it.concepto).slice(0, 45)}</td>` +
                `<td class="num" style="color:#059669">${formatearMoneda(it.ingresos)}</td>` +
                `<td class="num" style="color:#dc2626">${formatearMoneda(it.egresos)}</td></tr>`;
        tIng += it.ingresos || 0; tEgr += it.egresos || 0;
    });
    html += `</tbody><tfoot><tr><td colspan="2"><b>TOTAL</b></td>` +
            `<td class="num"><b>${formatearMoneda(tIng)}</b></td>` +
            `<td class="num"><b>${formatearMoneda(tEgr)}</b></td></tr></tfoot>`;
    tbl.innerHTML = html;
    // [F2.5+] Torta por categoría: Ingresos vs Egresos agregados
    dibujarTortaConceptoCategorias(items);
}

// Torta de Ingresos vs Egresos por Categoría (solo montos > 0)
function dibujarTortaConceptoCategorias(items) {
    const canvas = document.getElementById("chartConceptoCategorias");
    if (!canvas) return;
    _destruirChart("chartConceptoCategorias");
    const porCat = {};
    items.forEach(it => {
        const cat = String(it.categoria || "General").slice(0, 24);
        const k = "cat:" + cat;
        if (!porCat[k]) porCat[k] = { cat, ing: 0, egr: 0 };
        porCat[k].ing += it.ingresos || 0;
        porCat[k].egr += it.egresos || 0;
    });
    const cats = Object.values(porCat).filter(c => c.ing > 0 || c.egr > 0);
    if (!cats.length) return;
    const labels = cats.map(c => c.cat);
    const dataIng = cats.map(c => c.ing);
    const dataEgr = cats.map(c => c.egr);
        _crearChartTipo("chartConceptoCategorias", {
        type: "bar",
        data: {
            labels,
            datasets: [
                { label: "Ingresos", data: dataIng, backgroundColor: colorSerie("ingresos"), borderRadius: 6 },
                { label: "Egresos", data: dataEgr, backgroundColor: colorSerie("egresos"), borderRadius: 6 },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: "top" },
                title: { display: true, text: "Ingresos vs Egresos por Categoría", font: { size: 13, weight: "600" } },
                tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatearMoneda(ctx.raw)}` } },
            },
            scales: {
                y: { beginAtZero: true, ticks: { callback: (v) => formatearNum(v, 0) } },
            },
        },
    }, "bar");
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw("chartConceptoCategorias", () => dibujarTortaConceptoCategorias(items));
    }
}

// [B2-B8 · Cobertura total Excel] Sub-tablas por CATEGORÍA: una sección
// colapsable por cada categoria de la matriz ("Gastos fijos", "Consultas",
// "Cirugías"...) con sus conceptos, I/E, saldo y conteos — réplica de las
// sub-tablas que María Elena arma a mano. Datos: modulos_derivados.por_concepto.
function renderizarSubtablasCategorias(modulosDerivados) {
    const cont = document.getElementById("wrap-subtablas-categorias");
    if (!cont) return;
    const items = (modulosDerivados && modulosDerivados.por_concepto) || [];
    if (!items.length) { cont.innerHTML = ""; return; }

    // Agrupar por categoria (respetando el filtro de columnas apagadas)
    const porCat = {};
    items.forEach(it => {
        const cat = String(it.categoria || "General");
        if (!porCat[cat]) porCat[cat] = [];
        porCat[cat].push(it);
    });

    const cats = Object.keys(porCat).sort((a, b) => {
        const saldoA = porCat[a].reduce((s, i) => s + (i.ingresos || 0) - (i.egresos || 0), 0);
        const saldoB = porCat[b].reduce((s, i) => s + (i.ingresos || 0) - (i.egresos || 0), 0);
        return Math.abs(saldoB) - Math.abs(saldoA);
    });

    // Estado persistido de expansión por categoría (localStorage).
    // [Fix · 09/09] Por defecto TODAS abiertas (María Elena quiere verlas
    // desglosadas); solo quedan cerradas las categorías que ella colapsó antes.
    const STORAGE_KEY = "zenit_subtablas_categorias";
    let expandidas = null;
    try { expandidas = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (_) { expandidas = null; }
    if (expandidas === null || typeof expandidas !== "object") expandidas = {};

    const toggleTodas = (abrir) => {
        cats.forEach((cat, ci) => {
            const el = document.getElementById("subtabla-cat-" + ci);
            if (el) el.open = abrir;
            expandidas[cat] = abrir;
        });
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(expandidas)); } catch (_) {}
    };
    _toggleTodasSubtablas = toggleTodas;

    cont.innerHTML = '<div class="fw-bold mb-2" style="font-size:14px">📁 Sub-tablas por categoría</div>' +
        '<div class="mb-2" style="display:flex;gap:6px;flex-wrap:wrap">' +
        '<button class="z-btn z-btn-sm btn-outline-secondary" onclick="_toggleTodasSubtablas(true)">📖 Expandir todo</button>' +
        '<button class="z-btn z-btn-sm btn-outline-secondary" onclick="_toggleTodasSubtablas(false)">📕 Colapsar todo</button>' +
        '</div>' +
        cats.map((cat, ci) => {
        const filas = porCat[cat];
        const tIng = filas.reduce((s, f) => s + (f.ingresos || 0), 0);
        const tEgr = filas.reduce((s, f) => s + (f.egresos || 0), 0);
        const saldo = tIng - tEgr;
        const margenPct = tIng > 0 ? ((saldo / tIng) * 100) : null;
        const tConsIng = filas.reduce((s, f) => s + (f.conteo_ingresos || 0), 0);
        const tConsEgr = filas.reduce((s, f) => s + (f.conteo_egresos || 0), 0);
        const id = "subtabla-cat-" + ci;
        const chartId = "chart-subtabla-cat-" + ci;
        const abierta = expandidas[cat] !== false;
        const filasHtml = filas.map(f => "<tr>" +
            "<td>" + String(f.concepto || "—").slice(0, 40) + "</td>" +
            "<td style='text-align:center'>" + (f.conteo_ingresos || 0) + "</td>" +
            "<td style='text-align:center'>" + (f.conteo_egresos || 0) + "</td>" +
            "<td style='text-align:right'>" + (f.ingresos ? formatearMoneda(f.ingresos) : "—") + "</td>" +
            "<td style='text-align:right'>" + (f.egresos ? formatearMoneda(f.egresos) : "—") + "</td>" +
            "<td style='text-align:right;color:" + ((f.ingresos || 0) - (f.egresos || 0) >= 0 ? "var(--zx-ingresos)" : "var(--zx-egresos)") + "'>" +
                formatearMoneda((f.ingresos || 0) - (f.egresos || 0)) + "</td>" +
            "</tr>").join("");
        return '<details class="border rounded mb-2" style="background:var(--zn-50)" id="' + id + '" ' + (abierta ? "open" : "") + '>' +
            '<summary style="cursor:pointer;padding:10px 14px;font-weight:600;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;list-style:none">' +
            '<span style="font-size:16px">📁 ' + cat + '</span>' +
            '<span class="z-badge z-badge-light">' + filas.length + ' conceptos</span>' +
            '<span style="color:var(--zx-ingresos);font-size:12px">I: ' + formatearMoneda(tIng) + ' (' + tConsIng + ')</span>' +
            '<span style="color:var(--zx-egresos);font-size:12px">E: ' + formatearMoneda(tEgr) + ' (' + tConsEgr + ')</span>' +
            '<span style="font-size:12px;color:var(--zn-600)">Saldo: ' + formatearMoneda(saldo) + '</span>' +
            (margenPct !== null ? '<span class="z-badge" style="color:#fff;background:' + (margenPct >= 0 ? 'var(--zx-ingresos)' : 'var(--zx-egresos)') + '">Margen: ' + formatearPct(margenPct) + '</span>' : "") +
            '</summary>' +
            '<div style="padding:0 14px 10px">' +
              '<div style="height:180px;margin-bottom:10px"><canvas id="' + chartId + '"></canvas></div>' +
              '<div style="max-height:260px;overflow:auto">' +
              '<table class="z-tabla-mini" style="width:100%"><thead><tr>' +
              '<th style="text-align:left">Concepto</th><th style="text-align:center">Ing.</th><th style="text-align:center">Egr.</th>' +
              '<th style="text-align:right">Ingresos</th><th style="text-align:right">Egresos</th><th style="text-align:right">Saldo</th>' +
              '</tr></thead><tbody>' + filasHtml + '</tbody></table>' +
              '</div>' +
            '</div></details>';
    }).join("");

    // Dibujar la mini-gráfica de cada categoría (barras I/E por concepto)
    cats.forEach((cat, ci) => {
        dibujarMiniGraficoCategoria("chart-subtabla-cat-" + ci, porCat[cat], cat);
    });

    // Persistir expansión al toggle + redibujar mini-gráfica al abrir
    cats.forEach((cat, ci) => {
        const el = document.getElementById("subtabla-cat-" + ci);
        const chartId = "chart-subtabla-cat-" + ci;
        if (el) {
            el.addEventListener("toggle", () => {
                if (el.open) {
                    expandidas[cat] = true;
                    setTimeout(() => dibujarMiniGraficoCategoria(chartId, porCat[cat], cat), 10);
                } else {
                    expandidas[cat] = false;
                }
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(expandidas)); } catch (_) {}
            });
        }
    });
}

// Mini-gráfica de una categoría: barras Ingresos vs Egresos de los top conceptos.
function dibujarMiniGraficoCategoria(canvasId, filas, categoria) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    // Top 8 conceptos por |saldo| para mantener la gráfica legible
    const top = [...filas].sort((a, b) =>
        Math.abs((b.ingresos || 0) - (b.egresos || 0)) - Math.abs((a.ingresos || 0) - (a.egresos || 0))
    ).slice(0, 8);
    const labels = top.map(f => String(f.concepto || "—").slice(0, 18));
    _crearChartTipo(canvasId, {
        type: "bar",
        data: {
            labels,
            datasets: [
                { label: "Ingresos", data: top.map(f => f.ingresos || 0), backgroundColor: hexARgba(colorSerie("ingresos"), 0.7), borderRadius: 4 },
                { label: "Egresos", data: top.map(f => f.egresos || 0), backgroundColor: hexARgba(colorSerie("egresos"), 0.7), borderRadius: 4 },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: true, position: "top", labels: { boxWidth: 12, font: { size: 11 } } },
                title: { display: true, text: "Ingresos vs Egresos — " + categoria, font: { size: 12, weight: "600" } },
                tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ": " + formatearMoneda(ctx.raw) } },
            },
            scales: { y: { beginAtZero: true, ticks: { callback: v => formatearNum(v, 0), font: { size: 10 } } } },
        },
    }, "bar");
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw(canvasId, () => dibujarMiniGraficoCategoria(canvasId, filas, categoria));
    }
}

// ── [PRIORIDAD 0 · LISTA DUEÑO §5] Resumen mensual derivado de la matriz ────
// Tabla Mes × Consultas/Cirugías/Ingresos/Egresos/Margen/Margen% (datos:
// business.tabla_mensual) + promedio mensual + comparativa anual.
// Gráfica del Resumen (canvas resumenChart): misma fuente que la Tendencia.
function dibujarResumenChart(serieIng, serieEgr, serieMargen) {
    const canvas = document.getElementById("resumenChart");
    if (!canvas) return;
    if (!serieIng || !serieEgr) return;
    _crearChartTipo("resumenChart", {
        type: "bar",
        data: {
            labels: serieIng.labels,
            datasets: _datasetsIEMargen(serieIng, serieEgr, serieMargen),
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { display: true, position: "top" },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${formatearMoneda(ctx.raw)}`,
                    },
                },
            },
            scales: { y: { beginAtZero: true } },
        },
    }, "bar");
    // [Resumen-vs · 28/08] Registro para redibujo instantáneo (cambio de tipo
    // de gráfica y blindaje de tab oculto en switchTab).
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw("resumenChart", () => dibujarResumenChart(serieIng, serieEgr, serieMargen));
    }
}

// ── Comparador interactivo "vs" (Mes vs Mes · Mes vs Año · Año vs Año) ──────
let _cmpPeriodos = [];     // [{clave, label, anio, tipo:"mes"|"anio"}]
let _cmpFilas = [];        // filas de tabla_mensual

function poblarComparador(biz) {
    const selA = document.getElementById("cmp-a");
    const selB = document.getElementById("cmp-b");
    if (!selA || !selB) return;
    _cmpFilas = ((biz && biz.tabla_mensual) || {}).filas || [];
    const periodos = (biz && biz.periodos) || [];
    const opciones = [];
    const añosVistos = {};
    periodos.forEach(p => {
        const m = /^(\d{4})-(\d{2})$/.exec(p.clave || "");
        const anio = m ? m[1] : ((biz && biz.anio_detected) || "");
        opciones.push({
            clave: p.clave,
            label: (p.label || p.clave || "").trim(),
            anio,
            tipo: "mes",
            es_fecha: !!m,
        });
        if (anio) añosVistos[anio] = true;
    });
    Object.keys(añosVistos).sort().forEach(a => {
        opciones.push({ clave: "anio-" + a, label: "Año " + a, anio: a, tipo: "anio" });
    });
    _cmpPeriodos = opciones;
    if (!opciones.length) {
        selA.innerHTML = '<option value="">— sin períodos —</option>';
        selB.innerHTML = selA.innerHTML;
        return;
    }
    // [Resumen-vs · 28/08] Optgroups para distinguir Meses de Años a la vista.
    const optsMes = opciones.filter(o => o.tipo === "mes");
    const optsAnio = opciones.filter(o => o.tipo === "anio");
    const htmlMes = optsMes.map(o => `<option value="${o.clave}">${o.label}</option>`).join("");
    const htmlAnio = optsAnio.length
        ? `<optgroup label="Años">` + optsAnio.map(o => `<option value="${o.clave}">${o.label}</option>`).join("") + `</optgroup>`
        : "";
    selA.innerHTML = `<optgroup label="Meses">${htmlMes}</optgroup>` + htmlAnio;
    selB.innerHTML = selA.innerHTML;
    if (opciones.length >= 2) selB.value = opciones[1].clave;
}

function _sumarFilasDeAnio(filas, anio) {
    const res = filas.filter(f => {
        const m = /(\d{4})\s*$/.exec(String(f.mes || ""));
        return m && m[1] === anio;
    });
    if (!res.length) return null;
    return {
        mes: "Año " + anio,
        consultas: res.reduce((s, f) => s + (f.consultas || 0), 0),
        cirugias: res.reduce((s, f) => s + (f.cirugias || 0), 0),
        ingresos: res.reduce((s, f) => s + (f.ingresos || 0), 0),
        egresos: res.reduce((s, f) => s + (f.egresos || 0), 0),
        margen: res.reduce((s, f) => s + (f.margen || 0), 0),
        margen_pct: null,
    };
}

function _filaDePeriodo(p, filas) {
    if (p.tipo === "anio") return _sumarFilasDeAnio(filas, p.anio);
    // mes: la fila puede tener el label ("Enero"), el label con año ("Enero 2026"),
    // la clave fecha ("2026-01") o el nombre normalizado ("enero").
    const norm = x => String(x || "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const label = norm(p.label);
    const clave = norm(p.clave);
    return filas.find(f => {
        const txt = norm(f.mes);
        if (!txt) return false;
        if (txt === label || txt === clave) return true;
        // "Enero 2026" → quitar año y comparar contra label
        if (p.anio && txt.endsWith(String(p.anio))) {
            if (norm(txt.slice(0, -String(p.anio).length).trim()) === label) return true;
        }
        return false;
    }) || null;
}

function compararPeriodos() {
    const res = document.getElementById("comparador-resultado");
    if (!res) return;
    const selA = document.getElementById("cmp-a");
    const selB = document.getElementById("cmp-b");
    const pa = _cmpPeriodos.find(o => o.clave === selA.value);
    const pb = _cmpPeriodos.find(o => o.clave === selB.value);
    if (!pa || !pb || pa.clave === pb.clave) {
        res.innerHTML = '<span class="text-muted">Elige dos períodos distintos.</span>';
        return;
    }
    const fa = _filaDePeriodo(pa, _cmpFilas);
    const fb = _filaDePeriodo(pb, _cmpFilas);
    if (!fa || !fb) {
        res.innerHTML = '<span class="text-muted">No hay datos suficientes para comparar esos períodos.</span>';
        return;
    }
    const metricas = [
        ["Consultas", "consultas", "n"], ["Cirugías", "cirugias", "n"],
        ["Ingresos", "ingresos", "m"], ["Egresos", "egresos", "m"],
        ["Margen", "margen", "m"],
    ];
    // [FIX · 28/08] `let` (no const): se reasigna con += para la fila Margen %
    // ("Assignment to constant variable" rompía el comparador — reportado por
    // el dueño en producción).
    let filasHtml = metricas.map(([nombre, key, tipo]) => {
        const va = fa[key] || 0, vb = fb[key] || 0;
        const variacion = va !== 0 ? ((vb - va) / Math.abs(va)) * 100 : null;
        const val = tipo === "m" ? formatearMoneda : v => String(v);
        const signo = variacion !== null
            ? '<span style="color:' + (variacion >= 0 ? "var(--zx-ingresos)" : "var(--zx-egresos)") + '">' +
              formatearPct(variacion) + '</span>'
            : "—";
        return "<tr><td>" + nombre + "</td>" +
            "<td style='text-align:right'>" + val(va) + "</td>" +
            "<td style='text-align:right'>" + val(vb) + "</td>" +
            "<td style='text-align:right'>" + signo + "</td></tr>";
    }).join("");
    const margenAPct = fa.ingresos ? ((fa.margen / fa.ingresos) * 100) : null;
    const margenBPct = fb.ingresos ? ((fb.margen / fb.ingresos) * 100) : null;
    filasHtml += "<tr><td>Margen %</td>" +
        "<td style='text-align:right'>" + (margenAPct !== null ? formatearPct(margenAPct) : "—") + "</td>" +
        "<td style='text-align:right'>" + (margenBPct !== null ? formatearPct(margenBPct) : "—") + "</td>" +
        "<td style='text-align:right'>—</td></tr>";

    res.innerHTML =
        '<div class="fw-bold mt-2 mb-1" style="font-size:13px">📊 ' + pa.label + ' vs ' + pb.label + '</div>' +
        '<div class="z-card p-2 d-none" id="comparador-chart-wrap" style="margin-bottom:8px">' +
        '<canvas id="comparadorChart" style="height:220px;width:100%"></canvas></div>' +
        '<table class="z-tabla-mini" style="width:100%"><thead><tr>' +
        '<th style="text-align:left">Métrica</th><th>' + pa.label + '</th><th>' + pb.label + '</th><th>Variación</th>' +
        '</tr></thead><tbody>' + filasHtml + '</tbody></table>';

    _crearChartTipo("comparadorChart", {
        type: "bar",
        data: {
            labels: ["Ingresos", "Egresos", "Margen"],
            datasets: [
                { label: pa.label, data: [fa.ingresos, fa.egresos, fa.margen],
                  backgroundColor: hexARgba(colorSerie("ingresos"), 0.6), borderRadius: 6 },
                { label: pb.label, data: [fb.ingresos, fb.egresos, fb.margen],
                  backgroundColor: hexARgba("#7c3aed", 0.6), borderRadius: 6 },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: true, position: "top" },
                tooltip: { callbacks: { label: (ctx) => formatearMoneda(ctx.raw) } },
            },
            scales: { y: { beginAtZero: true } },
        },
    }, "bar");
    const wrapChart = document.getElementById("comparador-chart-wrap");
    if (wrapChart) wrapChart.classList.remove("d-none");
}

function renderizarResumenMensual(biz, meta) {
    const wrap = document.getElementById("wrap-resumen-mensual");
    const body = document.getElementById("resumen-mensual-body");
    if (!wrap || !body) return;
    const tm = (biz && biz.tabla_mensual) || {};
    const filas = tm.filas || [];
    if (!filas.length) { wrap.classList.add("d-none"); return; }
    wrap.classList.remove("d-none");

    // [Prioridad 1 · vs Meta por mes] metaNum>0 → ✅/❌ por mes en la tabla.
    const metaNum = Number(meta) || 0;

    // Gráfica I/E/Margen del Resumen (misma fuente que la Tendencia)
    const sI = (biz && biz._serie_mensual_ingresos) || null;
    const sE = (biz && biz._serie_mensual_egresos) || null;
    const sM = (biz && biz._serie_mensual_margen) || null;
    dibujarResumenChart(sI, sE, sM);

    // Totales para el tfoot
    const tIng = filas.reduce((s, f) => s + (f.ingresos || 0), 0);
    const tEgr = filas.reduce((s, f) => s + (f.egresos || 0), 0);
    const tMg = filas.reduce((s, f) => s + (f.margen || 0), 0);
    const tPct = tIng > 0 ? ((tMg / tIng) * 100).toFixed(1) : "0.0";

    body.innerHTML = '<thead><tr>' +
        '<th>Mes</th><th style="text-align:center">Consultas</th><th style="text-align:center">Cirugías</th>' +
        '<th style="text-align:right">Ingresos</th><th style="text-align:right">Egresos</th>' +
        '<th style="text-align:right">Margen</th><th style="text-align:right">Margen %</th>' +
        (metaNum > 0 ? '<th style="text-align:center">vs Meta</th>' : '') +
        '</tr></thead><tbody>' +
        filas.map(f => "<tr>" +
            "<td>" + f.mes + "</td>" +
            "<td style='text-align:center'>" + (f.consultas || 0) + "</td>" +
            "<td style='text-align:center'>" + (f.cirugias || 0) + "</td>" +
            "<td style='text-align:right'>" + formatearMoneda(f.ingresos) + "</td>" +
            "<td style='text-align:right'>" + formatearMoneda(f.egresos) + "</td>" +
            "<td style='text-align:right;color:" +
                (f.margen >= 0 ? "var(--zx-ingresos)" : "var(--zx-egresos)") + "'>" +
                formatearMoneda(f.margen) + "</td>" +
            "<td style='text-align:right'>" +
                (f.margen_pct !== null && f.margen_pct !== undefined
                    ? formatearPct(f.margen_pct) : "—") + "</td>" +
            (metaNum > 0 ? ("<td style='text-align:center'>" +
                ((f.margen || 0) >= metaNum ? "✅" : "❌") + "</td>") : "") +
            "</tr>").join("") +
        '</tbody><tfoot><tr>' +
        '<td><b>TOTAL</b></td>' +
        "<td style='text-align:center'><b>" + tC + "</b></td>" +
        "<td style='text-align:center'><b>" + tG + "</b></td>" +
        "<td style='text-align:right'><b>" + formatearMoneda(tIng) + "</b></td>" +
        "<td style='text-align:right'><b>" + formatearMoneda(tEgr) + "</b></td>" +
        "<td style='text-align:right'><b>" + formatearMoneda(tMg) + "</b></td>" +
        "<td style='text-align:right'><b>" + tPct + "%</b></td>" +
        (metaNum > 0 ? '<td></td>' : '') +
        '</tr></tfoot>';

    // KPIs operativos del período (totales = suma de los meses)
    const tC = filas.reduce((s, f) => s + (f.consultas || 0), 0);
    const tG = filas.reduce((s, f) => s + (f.cirugias || 0), 0);
    const kpis = document.getElementById("resumen-mensual-kpis");
    if (kpis) kpis.innerHTML =
        '<span class="z-badge z-badge-light">🩺 N° Consultas: <b>' + tC + '</b></span>' +
        '<span class="z-badge z-badge-light">🔬 N° Cirugías: <b>' + tG + '</b></span>';

    const prom = document.getElementById("resumen-mensual-promedio");
    if (prom) prom.textContent =
        "Promedio mensual — Margen: " + formatearMoneda(tm.promedio_mensual_margen) +
        " · Ingresos: " + formatearMoneda(tm.promedio_mensual_ingresos) +
        (metaNum > 0 ? " · 🎯 Meta: " + formatearMoneda(metaNum) + " por mes"
                     : " · Define una 🎯 Meta para ver el cumplimiento por mes");

    // Comparador interactivo
    poblarComparador(biz);
    renderizarComparativaAnual(filas, meta);
    // [P0B · D-4] Resumen anual completo lado a lado (réplica del Excel)
    renderizarTablasParalelasAnuales(filas);
    // [P-12 · 09/09] Línea doble 2025 vs 2026 (eje X = mes sin año)
    renderizarAnioVsAnioChart(filas);
}

// Comparativa anual: mini-tabla por año + tablita Mes | Margen a1 | Margen a2
// | Variación | vs Meta (meta del período definida por el usuario; si no hay
// meta, la columna muestra "—" — nunca se inventa una regla de cumplimiento).
function _anioDeMes(mes) {
    const m = /(\d{4})\s*$/.exec(String(mes || ""));
    return m ? m[1] : "";
}

// [P-12 · 09/09] LÍNEA DOBLE 2025 vs 2026: gráfico de línea superpuesta
// con eje X = mes sin año. Dos datasets (uno por año), valores null donde
// no hay datos para ese mes. Datos: business.tabla_mensual.filas.
function renderizarAnioVsAnioChart(filas) {
    const wrap = document.getElementById("wrap-anio-vs-anio");
    const cv = document.getElementById("chartAnioVsAnio");
    const tblBody = document.getElementById("tabla-anio-vs-anio");
    const sub = document.getElementById("anio-vs-anio-sub");
    if (!wrap || !cv) return;
    // Separar por año (los 2 más recientes cronológicamente)
    const porAnio = {};
    filas.forEach(f => {
        const a = _anioDeMes(f.mes);
        if (!a) return;
        (porAnio[a] = porAnio[a] || []).push(f);
    });
    const anios = Object.keys(porAnio).sort();
    if (anios.length < 2) { wrap.classList.add("d-none"); return; }
    const a1 = anios[anios.length - 2];
    const a2 = anios[anios.length - 1];
    // Ordenar meses naturalmente (Ene..Dic)
    const ordenMeses = ["enero","febrero","marzo","abril","mayo","junio",
                        "julio","agosto","septiembre","octubre","noviembre","diciembre"];
    const _numMes = m => {
        const k = String(m || "").trim().toLowerCase();
        return ordenMeses.findIndex(x => k.includes(x));
    };
    const mapa1 = {}, mapa2 = [];
    porAnio[a1].forEach(f => { mapa1[_numMes(f.mes)] = f; });
    porAnio[a2].forEach(f => { mapa2[_numMes(f.mes)] = f; });
    // Construir ejes: meses union de ambos años, ordenados
    const mesesUnion = [...new Set([...Object.keys(mapa1), ...Object.keys(mapa2)])].map(Number).sort((a, b) => a - b);
    const labelsMes = mesesUnion.map(i => ordenMeses[i] ? ordenMeses[i].charAt(0).toUpperCase() + ordenMeses[i].slice(0, 3) : "M" + (i + 1));
    const data1 = mesesUnion.map(i => mapa1[i] ? (mapa1[i].margen || 0) : null);
    const data2 = mesesUnion.map(i => mapa2[i] ? (mapa2[i].margen || 0) : null);
    wrap.classList.remove("d-none");
    if (sub) sub.textContent = `Margen mensual · ${a1} vs ${a2}`;
    _destruirChart("chartAnioVsAnio");
    new Chart(cv, {
        type: "line",
        data: {
            labels: labelsMes,
            datasets: [
                { label: a1, data: data1, borderColor: "#7C3AED", backgroundColor: "rgba(124,58,237,0.08)",
                  borderWidth: 2, pointRadius: 4, tension: 0.3, fill: false,
                  spanGaps: true },
                { label: a2, data: data2, borderColor: "#059669", backgroundColor: "rgba(5,150,105,0.08)",
                  borderWidth: 2, pointRadius: 4, tension: 0.3, fill: false,
                  spanGaps: true },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: "top", labels: { font: { size: 11 } } },
                tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${formatearMoneda(ctx.raw)}` } },
            },
            scales: {
                x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                y: { beginAtZero: true, ticks: { font: { size: 10 }, callback: v => formatearNum(v, 0) } },
            },
        },
    });
    // Tabla comparativa Mes | Año A | Año B | Variación %
    if (tblBody) {
        const filasTabla = mesesUnion.map(i => {
            const m1 = mapa1[i] ? (mapa1[i].margen || 0) : null;
            const m2 = mapa2[i] ? (mapa2[i].margen || 0) : null;
            const nombreMes = ordenMeses[i] ? ordenMeses[i].charAt(0).toUpperCase() + ordenMeses[i].slice(0, 3) : "M" + (i + 1);
            const vari = (m1 !== null && m1 !== 0 && m2 !== null)
                ? ((m2 - m1) / Math.abs(m1)) * 100 : null;
            return "<tr>" +
                "<td>" + nombreMes + "</td>" +
                "<td style='text-align:right'>" + (m1 !== null ? formatearMoneda(m1) : "—") + "</td>" +
                "<td style='text-align:right'>" + (m2 !== null ? formatearMoneda(m2) : "—") + "</td>" +
                "<td style='text-align:right;color:" +
                    (vari !== null && vari >= 0 ? "var(--zx-ingresos)" : "var(--zx-egresos)") + "'>" +
                    (vari !== null ? formatearPct(vari) : "—") + "</td></tr>";
        }).join("");
        tblBody.innerHTML = filasTabla;
    }
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw("chartAnioVsAnio", () => renderizarAnioVsAnioChart(filas));
    }
}

function renderizarComparativaAnual(filas, meta) {
    const cont = document.getElementById("comparativa-anual");
    if (!cont) return;
    const porAnio = {};
    filas.forEach(f => {
        const a = _anioDeMes(f.mes) || "—";
        (porAnio[a] = porAnio[a] || []).push(f);
    });
    // [Resumen-vs · 28/08] Solo años REALES (ignora filas sin año, que antes
    // se agrupaban como "—" y podían compararse contra un año) y compara los
    // DOS AÑOS MÁS RECIENTES cronológicamente.
    const anios = Object.keys(porAnio).filter(a => a && a !== "—").sort();
    if (anios.length < 2) { cont.innerHTML = ""; return; }
    const a1 = anios[anios.length - 2];
    const a2 = anios[anios.length - 1];
    const sinAnio = new RegExp("\\s*" + a1 + "\\s*$");

    const tablaAnio = (anio, titulo) => {
        const filasHtml = porAnio[anio].map(f => "<tr>" +
            "<td>" + String(f.mes).replace(new RegExp("\\s*" + anio + "\\s*$"), "") + "</td>" +
            "<td style='text-align:center'>" + (f.consultas || 0) + "</td>" +
            "<td style='text-align:center'>" + (f.cirugias || 0) + "</td>" +
            "<td style='text-align:right'>" + formatearMoneda(f.ingresos) + "</td>" +
            "<td style='text-align:right'>" + formatearMoneda(f.margen) + "</td>" +
            "<td style='text-align:right'>" +
                (f.margen_pct !== null && f.margen_pct !== undefined
                    ? formatearPct(f.margen_pct) : "—") + "</td></tr>").join("");
        return '<div class="z-card p-2" style="min-width:280px">' +
            '<div class="fw-bold mb-1" style="font-size:13px">' + titulo + '</div>' +
            '<table class="z-tabla-mini" style="width:100%"><thead><tr>' +
            '<th>Mes</th><th>Cons.</th><th>Cir.</th><th>Ingresos</th>' +
            '<th>Margen</th><th>%</th></tr></thead><tbody>' + filasHtml +
            '</tbody></table></div>';
    };

    const mapa1 = {}, mapa2 = {};
    porAnio[a1].forEach(f => { mapa1[String(f.mes).replace(sinAnio, "")] = f; });
    porAnio[a2].forEach(f => { mapa2[String(f.mes).replace(new RegExp("\\s*" + a2 + "\\s*$"), "")] = f; });
    const meses = Object.keys(mapa1).filter(m => mapa2[m]);
    const metaNum = Number(meta) || 0;
    const filasComp = meses.map(m => {
        const m1 = mapa1[m].margen || 0, m2 = mapa2[m].margen || 0;
        const vari = m1 !== 0 ? ((m2 - m1) / Math.abs(m1)) * 100 : null;
        const vsMeta = metaNum > 0 ? (m2 >= metaNum ? "✅" : "❌") : "—";
        return "<tr>" +
            "<td>" + m + "</td>" +
            "<td style='text-align:right'>" + formatearMoneda(m1) + "</td>" +
            "<td style='text-align:right'>" + formatearMoneda(m2) + "</td>" +
            "<td style='text-align:right;color:" +
                (m2 >= m1 ? "var(--zx-ingresos)" : "var(--zx-egresos)") + "'>" +
                (vari !== null ? formatearPct(vari) : "—") + "</td>" +
            "<td style='text-align:center'>" + vsMeta + "</td></tr>";
    }).join("");

    cont.innerHTML =
        '<div class="fw-bold mb-1" style="font-size:13px">📊 Comparativa ' + a1 + ' vs ' + a2 + '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">' +
        tablaAnio(a1, "Resumen " + a1) + tablaAnio(a2, "Resumen " + a2) + '</div>' +
        '<table class="z-tabla-mini mt-2" style="width:100%"><thead><tr>' +
        '<th style="text-align:left">Mes</th><th>Margen ' + a1 + '</th>' +
        '<th>Margen ' + a2 + '</th><th>Variación</th><th>vs Meta</th>' +
        '</tr></thead><tbody>' + filasComp + '</tbody></table>' +
        (metaNum > 0 ? '' :
            '<div class="text-muted small mt-1">Define una 🎯 Meta para ver si cada mes la cumplió.</div>');
}

// [P0B · D-4] RESUMEN ANUAL COMPLETO lado a lado (réplica del Excel):
// dos tablas paralelas por año (2025 | 2026) con columnas CONSULTAS ·
// CIRUGÍAS · INGRESOS · EGRESOS · MARGEN $ · MARGEN %, filas por mes,
// y al pie: TOTAL · MARGEN DE UTILIDAD · PROMEDIO MENSUAL (margen/n meses).
// Fuente: tabla_mensual.filas (por mes-año) — sin duplicar backend.
function renderizarTablasParalelasAnuales(filas) {
    const cont = document.getElementById("tablas-anuales");
    if (!cont) return;
    const porAnio = {};
    (filas || []).forEach(f => {
        const a = _anioDeMes(f.mes);
        if (!a) return;  // sin año no participa (mes textual puro)
        (porAnio[a] = porAnio[a] || []).push(f);
    });
    const anios = Object.keys(porAnio).sort();
    if (anios.length < 1) { cont.innerHTML = ""; return; }

    const tablaAnual = (anio) => {
        const filasAnio = porAnio[anio];
        const tC = filasAnio.reduce((s, f) => s + (f.consultas || 0), 0);
        const tG = filasAnio.reduce((s, f) => s + (f.cirugias || 0), 0);
        const tI = filasAnio.reduce((s, f) => s + (f.ingresos || 0), 0);
        const tE = filasAnio.reduce((s, f) => s + (f.egresos || 0), 0);
        const tM = filasAnio.reduce((s, f) => s + (f.margen || 0), 0);
        const mPct = tI > 0 ? (tM / tI * 100) : null;
        const promedio = tM / Math.max(filasAnio.length, 1);
        const cu = v => (v >= 0 ? "var(--zx-ingresos)" : "var(--zx-egresos)");
        const filasHtml = filasAnio.map(f => "<tr>" +
            "<td>" + String(f.mes).replace(new RegExp("\\s*" + anio + "\\s*$"), "") + "</td>" +
            "<td style='text-align:center'>" + (f.consultas || 0) + "</td>" +
            "<td style='text-align:center'>" + (f.cirugias || 0) + "</td>" +
            "<td style='text-align:right'>" + formatearMoneda(f.ingresos) + "</td>" +
            "<td style='text-align:right'>" + formatearMoneda(f.egresos) + "</td>" +
            "<td style='text-align:right;color:" + cu(f.margen) + "'>" + formatearMoneda(f.margen) + "</td>" +
            "<td style='text-align:right'>" + (f.margen_pct != null ? formatearPct(f.margen_pct) : "—") + "</td></tr>").join("");
        return '<div class="z-card p-2" style="min-width:300px">' +
            '<div class="fw-bold mb-1" style="font-size:13px">📋 RESUMEN ' + anio + '</div>' +
            '<table class="z-tabla-mini" style="width:100%"><thead><tr>' +
            '<th style="text-align:left">Mes</th><th style="text-align:center">Cons.</th><th style="text-align:center">Cir.</th>' +
            '<th style="text-align:right">Ingresos</th><th style="text-align:right">Egresos</th>' +
            '<th style="text-align:right">Margen $</th><th style="text-align:right">Margen %</th>' +
            '</tr></thead><tbody>' + filasHtml + '</tbody>' +
            '<tfoot>' +
            '<tr style="font-weight:700"><td>TOTAL</td><td style="text-align:center">' + tC + '</td>' +
            '<td style="text-align:center">' + tG + '</td><td style="text-align:right">' + formatearMoneda(tI) + '</td>' +
            '<td style="text-align:right">' + formatearMoneda(tE) + '</td>' +
            '<td style="text-align:right;color:' + cu(tM) + '">' + formatearMoneda(tM) + '</td>' +
            '<td style="text-align:right">' + (mPct != null ? formatearPct(mPct) : "—") + '</td></tr>' +
            '<tr><td>MARGEN DE UTILIDAD</td><td colspan="5"></td>' +
            '<td style="text-align:right;color:' + cu(tM) + '">' + formatearMoneda(tM) + '</td><td></td></tr>' +
            '<tr><td>PROMEDIO MENSUAL</td><td colspan="5"></td>' +
            '<td style="text-align:right">' + formatearMoneda(promedio) + '</td><td></td></tr>' +
            '</tfoot></table>' +
            '</div>';
    };

    cont.innerHTML =
        '<div class="fw-bold mb-1" style="font-size:13px">📊 Resumen anual completo (lado a lado)</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px">' +
        anios.map(tablaAnual).join("") + '</div>';
}

// [R-4 · 30/08] INSIGHTS — conclusiones automáticas en texto (poblado desde
// datos que YA existen: narrative, anomalías, proyección, meta, PE).
// Este tab NO duplica gráficos: solo frases + cifras destacadas.

// [R-4] Extrae las primeras 1-2 oraciones de la narrativa para el callout
// del Resumen. Corta solo en ". " seguido de mayúscula (inicio de oración):
// el punto de MILES nunca va seguido de espacio ("1.234.567"), así que no
// hay falso corte a mitad de cifra; y "Bs. 1.234" no corta (siguiente=dígito).
// Si no hay cortes limpios, recorta en un espacio bajo 170 caracteres.
function _extraerFrasesDestacadas(texto, maxFrases) {
    maxFrases = maxFrases || 2;
    if (!texto) return "";
    const t = String(texto).replace(/\s+/g, " ").trim();
    const cortes = [];
    for (let i = 0; i < t.length - 2; i++) {
        if (t[i] === "." && t[i + 1] === " " && /[A-ZÁÉÍÓÚÑ]/.test(t[i + 2])) {
            cortes.push(i + 1);
        }
    }
    if (cortes.length === 0) {
        if (t.length <= 170) return t;
        const cut = t.lastIndexOf(" ", 170);
        return (cut > 0 ? t.slice(0, cut) : t.slice(0, 170)) + "…";
    }
    // cortes.length = número de oraciones - 1. Con maxFrases cortes hay
    // maxFrases+1 oraciones → hay que recortar en el corte maxFrases-1.
    if (cortes.length < maxFrases) return t;
    const fin = cortes[maxFrases - 1];
    return t.slice(0, fin + 1).trim();
}
function renderizarInsights(data) {
    const kpis = data.kpis || {};
    const biz = data.business || {};
    // Resumen ejecutivo completo (el párrafo generado)
    const resumenEl = document.getElementById("insights-resumen");
    if (resumenEl) {
        const completo = (data.narrative && data.narrative !== "Selecciona un dataset para ver el análisis.")
            ? data.narrative
            : "Selecciona un dataset para ver el análisis.";
        resumenEl.textContent = completo;
    }
    // Anomalías resumidas: contar las reales del contrato
    const anomEl = document.getElementById("insights-anomalias");
    if (anomEl) {
        // [FIX 09/09] El contrato trae anomalies como LISTA directa (o dict con items).
        // Antes: data.anomalies.items || [] → siempre vacío porque es lista.
        const _an = data.anomalies;
        const anoms = Array.isArray(_an) ? _an : ((_an && _an.items) || []);
        anomEl.innerHTML = anoms.length
            ? "<b>" + anoms.length + " valor(es) fuera de lo normal.</b> Revisa el tab 🗄️ Datos → Anomalías para el detalle."
            : "Sin anomalías detectadas en este bloque.";
    }
    // Proyección y tendencia — lee directo del contrato (no de DOM)
    const proyEl = document.getElementById("insights-proyeccion");
    if (proyEl) {
        const esc = biz.proyeccion_series && biz.proyeccion_series.margen;
        if (esc && esc.proximo !== null && esc.proximo !== undefined) {
            const dirTxt = esc.direccion === "creciente" ? "al alza" : (esc.direccion === "decreciente" ? "a la baja" : "estable");
            proyEl.innerHTML = `Tendencia: <b>${dirTxt}</b> · ${formatearMoneda(esc.pendiente || 0)}/período · próximo período ≈ <b>${formatearMoneda(Math.max(0, esc.proximo))}</b> (${esc.periodos} períodos analizados)`;
        } else {
            proyEl.textContent = "No hay suficientes períodos para proyectar.";
        }
    }
    // Meta del período — lee directo del contrato
    const metaEl = document.getElementById("insights-meta");
    if (metaEl) {
        if (kpis.meta && kpis.porcentaje_meta != null) {
            const pct = Number(kpis.porcentaje_meta);
            const icono = pct >= 100 ? "✅" : (pct >= 80 ? "🟡" : "⚠️");
            metaEl.innerHTML = `${icono} <b>${pct.toFixed(1)}% de la meta</b> (objetivo: ${formatearMoneda(kpis.meta)} · actual: ${formatearMoneda(kpis.suma || 0)})`;
        } else {
            metaEl.textContent = "Sin meta definida. Define una 🎯 Meta para ver el cumplimiento.";
        }
    }
    // Punto de equilibrio resumido — lee directo del contrato
    const peEl = document.getElementById("insights-pe");
    if (peEl) {
        const peData = biz.punto_equilibrio;
        if (peData && peData.ingresos_brutos > 0 && peData.resultado_operativo !== undefined) {
            const ro = Number(peData.resultado_operativo);
            if (ro > 0) {
                peEl.innerHTML = `✅ <b>Ya cubriste tus costos fijos</b> (${formatearMoneda(peData.gastos_fijos)}). A partir del PE, cada venta adicional es utilidad.`;
            } else if (ro < 0) {
                peEl.innerHTML = `📌 Te faltan <b>${formatearMoneda(Math.abs(ro))}</b> para cubrir costos fijos (${formatearMoneda(peData.gastos_fijos)}). Necesitas ~${Math.ceil(peData.pe_unidades)} unidades más.`;
            } else {
                peEl.textContent = "Estás justo en el punto de equilibrio.";
            }
        } else {
            peEl.textContent = "Sin datos suficientes para calcular el punto de equilibrio.";
        }
    }
}

// [Frente C · E4-dims v2] UNA SECCIÓN COMPLETA POR CADA DIMENSIÓN:
// mini-métricas + gráfico de barras I/E + tabla detalle. Generado dinámicamente.
function renderizarWidgetsDimensiones(modulosDerivados) {

    // [Plan F] Ocultar secciones de columnas apagadas.
    try { const _mv = _modulosVisiblesActual || {}; Object.keys((modulosDerivados || {}).por_dimension || {}).forEach(k => { if (_mv["col:" + k] === false) delete modulosDerivados.por_dimension[k]; }); } catch (_) {}    const cont = document.getElementById("wrap-dims-financieras");
    if (!cont) return;
    cont.innerHTML = "";
    const dims = (modulosDerivados && modulosDerivados.por_dimension) || {};
    const nombres = Object.keys(dims);
    if (!nombres.length) return;
    nombres.forEach((nombre, idx) => {
        const filas = dims[nombre];
        const totalIng = filas.reduce((a, f) => a + (f.ingresos || 0), 0);
        const totalEgr = filas.reduce((a, f) => a + (f.egresos || 0), 0);
        const saldo = totalIng - totalEgr;
        const sec = document.createElement("div");
        sec.className = "z-card";
        sec.style.marginBottom = "24px";
        sec.innerHTML = 
            '<div class="z-card-header"><span class="z-card-title">📊 Por ' + nombre + '</span><button class="btn btn-sm btn-outline-secondary ms-auto btn-detalle" onclick="return _alternarDetalle(\'detalle-dim-' + idx + '\', this)">📄 Detalle</button></div>' +
            '<div class="z-card-body p-3">' +
              '<div class="z-fin-grid" style="grid-template-columns:repeat(3,1fr); margin-bottom:16px;">' +
                finMini("Ingresos", formatearMoneda(totalIng), "#059669") +
                finMini("Egresos", formatearMoneda(totalEgr), "#dc2626") +
                finMini("Saldo", formatearMoneda(saldo), saldo >= 0 ? "#059669" : "#dc2626") +
              '</div>' +
              '<div style="height:300px; margin-bottom:14px;">' +
                '<canvas id="chart-dim-' + idx + '"></canvas>' +
              '</div>' +
              '<div id="detalle-dim-' + idx + '" class="z-detalle-wrap" style="max-height:280px; overflow:auto;">' +
                tablaDimHTML(filas) +
              '</div>' +
            '</div>';
        cont.appendChild(sec);
        _aplicarEstadoDetalle('detalle-dim-' + idx);
        dibujarChartDimension(idx, nombre, filas);
    });
}

function finMini(label, valor, color) {
    return '<div style="background:#fff; border-radius:10px; padding:10px 14px; border-top:2px solid ' + color + '; box-shadow:0 1px 3px rgba(15,23,42,.06);">' +
           '<div class="z-fin-label">' + label + '</div>' +
           '<div class="z-fin-value" style="font-size:1.1rem; color:' + color + '">' + valor + '</div></div>';
}

function tablaDimHTML(filas) {
    let html = '<table class="z-tabla-mini"><thead><tr><th>Valor</th><th class="num">Ingresos</th><th class="num">Egresos</th><th class="num">Saldo</th></tr></thead><tbody>';
    filas.forEach(f => {
        const cs = f.saldo >= 0 ? "#059669" : "#dc2626";
        html += '<tr><td>' + String(f.valor).slice(0, 40) + '</td>' +
                '<td class="num" style="color:#059669">' + formatearMoneda(f.ingresos) + '</td>' +
                '<td class="num" style="color:#dc2626">' + formatearMoneda(f.egresos) + '</td>' +
                '<td class="num fw-bold" style="color:' + cs + '">' + formatearMoneda(f.saldo) + '</td></tr>';
    });
    html += '</tbody></table>';
    return html;
}

function dibujarChartDimension(idx, nombre, filas) {
    const canvasId = "chart-dim-" + idx;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    _registrarTipoCanvas(canvasId, ["bar", "line", "area", "doughnut", "pie", "polarArea"]);
    const top = filas.slice(0, 12);
    _crearChartTipo(canvasId, {
        type: "bar",
        data: {
            labels: top.map(f => f.valor.slice(0, 20)),
            datasets: [
                { label: "Ingresos", data: top.map(f => f.ingresos), backgroundColor: colorColumna(nombre) || colorSerie("ingresos"), borderRadius: 5 },
                { label: "Egresos", data: top.map(f => f.egresos), backgroundColor: colorSerie("egresos"), borderRadius: 5 },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: "top" },
                title: { display: true, text: "Ingresos vs Egresos por " + nombre, font: { size: 13, weight: "600" } },
                tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ": " + formatearMoneda(ctx.raw) } },
            },
            scales: {
                y: { beginAtZero: true, ticks: { callback: v => formatearNum(v, 0) } },
                x: { ticks: { maxRotation: 45, minRotation: 30 } }, // [Fase 8] hereda font global 13px
            },
        },
    }, "bar");
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw(canvasId, () => dibujarChartDimension(idx, nombre, filas));
    }
}

// [Fix · 09/09] Selector de paciente + "ver todos". Antes estos botones
// llamaban _verPacienteMargen(i) PERO la función no estaba definida en
// producción (solo en un test de cuarentena) → seleccionar un paciente no
// mostraba su cuadro. Ahora se definen las 3 funciones de navegación.
function _verPacienteMargen(i) {
    document.querySelectorAll('[id^="cuadro-pac-"]').forEach(el => { el.style.display = "none"; });
    const activo = document.getElementById("cuadro-pac-" + i);
    if (activo) activo.style.display = "";
    document.querySelectorAll('[id^="pac-margen-"]').forEach(b => { b.style.background = "#fff"; b.style.borderColor = "var(--zn-200)"; });
    const btn = document.getElementById("pac-margen-" + i);
    if (btn) { btn.style.background = "var(--zp-50)"; btn.style.borderColor = "var(--zp-300)"; }
}

function _verTodosPacientes() {
    document.querySelectorAll('[id^="cuadro-pac-"]').forEach(el => { el.style.display = ""; });
}

function _contraerPacientes() {
    document.querySelectorAll('[id^="cuadro-pac-"]').forEach((el, idx) => {
        el.style.display = idx === 0 ? "" : "none";
    });
    document.querySelectorAll('[id^="pac-margen-"]').forEach((b, idx) => {
        b.style.background = idx === 0 ? "var(--zp-50)" : "#fff";
        b.style.borderColor = idx === 0 ? "var(--zp-300)" : "var(--zn-200)";
    });
}

// [B-2 + P0B · D-3] Margen por Entidad/Paciente.
// Tabla resumen (existente) + cuadro completo por operación (réplica del Excel
// "MARGEN POR PACIENTE"): (+) Precio cobrado · (-) cada egreso de cirugía listado
// · (=) Utilidad Neta · (%) Margen. + lista paralela de navegación.
// Fuente: business.margen_por_entidad (ingresos_detalle/egresos_detalle del backend).
function renderizarMargenEntidad(margenEnt) {
    const wrap = document.getElementById("wrap-margen-entidad");
    const tbl = document.getElementById("tabla-margen-entidad");
    const wrapPac = document.getElementById("wrap-margen-paciente");
    const listaPac = document.getElementById("lista-margen-paciente");
    const detPac = document.getElementById("detalle-margen-paciente");
    const wrapDetEnt = document.getElementById("wrap-margen-entidad-detalle");
    const wrapDetPac = document.getElementById("wrap-margen-paciente-detalle");
    const ents = (margenEnt && margenEnt.entidades) || [];
    if (!ents.length) {
        if (wrap) wrap.classList.add("d-none");
        if (wrapPac) wrapPac.classList.add("d-none");
        if (wrapDetEnt) wrapDetEnt.classList.add("d-none");
        if (wrapDetPac) wrapDetPac.classList.add("d-none");
        return;
    }
    const cu = v => (v >= 0 ? "var(--zx-ingresos)" : "var(--zx-egresos)");
    // ── Tabla resumen de entidad (existente) ──
    if (wrap && tbl) {
        wrap.classList.remove("d-none");
        if (wrapDetEnt) wrapDetEnt.classList.remove("d-none");
        let html = '<thead><tr><th>Entidad</th><th class="num">Ingresos</th><th class="num">Egresos</th><th class="num">Utilidad</th><th class="num">Margen %</th></tr></thead><tbody>';
        let tIng = 0, tEgr = 0, tUtil = 0;
        ents.forEach(e => {
            html += '<tr><td>' + String(e.entidad).slice(0, 32) + '</td>' +
                '<td class="num">' + formatearMoneda(e.ingresos) + '</td>' +
                '<td class="num">' + formatearMoneda(e.egresos) + '</td>' +
                '<td class="num fw-bold" style="color:' + cu(e.utilidad) + '">' + formatearMoneda(e.utilidad) + '</td>' +
                '<td class="num">' + (e.margen_pct === null ? "—" : e.margen_pct + "%") + '</td></tr>';
            tIng += e.ingresos || 0; tEgr += e.egresos || 0; tUtil += e.utilidad || 0;
        });
        html += `</tbody><tfoot><tr><td><b>TOTAL</b></td>` +
            `<td class="num"><b>${formatearMoneda(tIng)}</b></td>` +
            `<td class="num"><b>${formatearMoneda(tEgr)}</b></td>` +
            `<td class="num"><b>${formatearMoneda(tUtil)}</b></td>` +
            `<td class="num"></td></tr></tfoot>`;
        tbl.innerHTML = html;
        dibujarGraficoMargenEntidad(ents);
        dibujarGraficoMargenPaciente(ents);
    }
    // ── [P0B · D-3] Cuadro completo por paciente + lista paralela ──
    if (wrapPac && listaPac && detPac) {
        wrapPac.classList.remove("d-none");
        if (wrapDetPac) wrapDetPac.classList.remove("d-none");
        listaPac.innerHTML = '<div style="display:flex;gap:6px;margin-bottom:8px">' +
            '<button class="z-btn z-btn-sm btn-outline-secondary" style="flex:1" onclick="_verTodosPacientes()">📖 Ver todos</button>' +
            '<button class="z-btn z-btn-sm btn-outline-secondary" style="flex:1" onclick="_contraerPacientes()">🔽 Contraer</button>' +
            '</div>' +
            '<div style="display:flex;flex-direction:column;gap:6px">' +
            ents.map((e, i) => '<button class="text-start" style="cursor:pointer;padding:6px 8px;border:1px solid var(--zn-200);border-radius:8px;background:#fff;font-size:12px" ' +
                'onclick="_verPacienteMargen(' + i + ')" id="pac-margen-' + i + '">' +
                '<div style="font-weight:600">' + String(e.entidad).slice(0, 28) + '</div>' +
                '<div style="display:flex;justify-content:space-between;gap:6px;margin-top:2px">' +
                '<span style="color:var(--zx-ingresos)">' + formatearMoneda(e.ingresos) + '</span>' +
                '<span style="font-weight:700;color:' + cu(e.utilidad) + '">' + (e.margen_pct === null ? "—" : e.margen_pct + "%") + '</span>' +
                '</div></button>').join("") + '</div>';
        detPac.innerHTML = '<div style="display:flex;flex-direction:column;gap:12px">' +
            ents.map((e, i) => '<div id="cuadro-pac-' + i + '" ' + (i === 0 ? "" : 'style="display:none"') + '>' +
                '<div style="font-weight:700;font-size:14px;margin-bottom:6px">🧍 ' + String(e.entidad).slice(0, 40) + '</div>' +
                '<table class="z-tabla-mini" style="width:100%"><tbody>' +
                '<tr style="background:#f0fdf4"><td style="font-weight:600">(+) Precio Total Cobrado</td>' +
                    '<td style="text-align:right;color:var(--zx-ingresos);font-weight:700">' + formatearMoneda(e.ingresos) + '</td></tr>' +
                (e.ingresos_detalle || []).map(d => '<tr><td style="padding-left:16px;color:var(--zn-600)">↳ ' + String(d.concepto).slice(0, 45) + '</td>' +
                    '<td style="text-align:right">' + formatearMoneda(d.monto) + '</td></tr>').join("") +
                '<tr style="background:#fef2f2"><td style="font-weight:600">(-) Egresos de la cirugía</td>' +
                    '<td style="text-align:right;font-weight:700"></td></tr>' +
                (e.egresos_detalle || []).map(d => '<tr><td style="padding-left:16px;color:#dc2626">• ' + String(d.concepto).slice(0, 45) + '</td>' +
                    '<td style="text-align:right;color:#dc2626">- ' + formatearMoneda(d.monto) + '</td></tr>').join("") +
                '<tr style="font-weight:700;border-top:2px solid var(--zn-300)"><td>(=) Total Costos Variables</td>' +
                    '<td style="text-align:right;color:#dc2626">' + formatearMoneda(e.egresos) + '</td></tr>' +
                '<tr style="font-weight:700;background:var(--zn-50)"><td>(=) Utilidad Neta Paciente</td>' +
                    '<td style="text-align:right;color:' + cu(e.utilidad) + '">' + formatearMoneda(e.utilidad) + '</td></tr>' +
                '<tr style="font-weight:700"><td>(%) Margen de Ganancia</td>' +
                    '<td style="text-align:right;color:' + cu(e.utilidad) + '">' + (e.margen_pct === null ? "—" : e.margen_pct + "%") + '</td></tr>' +
                '</tbody></table></div>').join("") + '</div>';
    }
}

function dibujarGraficoMargenEntidad(ents) {
    const cv = document.getElementById("chartMargenEntidad");
    if (!cv) return;
    const top = ents.slice(0, 12);
    _crearChartTipo("chartMargenEntidad", {
        type: "bar",
        data: {
            labels: top.map(e => String(e.entidad).slice(0, 18)),
            datasets: [{
                label: "Utilidad",
                data: top.map(e => e.utilidad),
                backgroundColor: top.map(e => e.utilidad >= 0 ? colorSerie("ingresos") : colorSerie("egresos")),
                borderRadius: 5,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: "y",
            plugins: {
                legend: { display: false },
                title: { display: true, text: "Utilidad por Entidad", font: { size: 13, weight: "600" } },
                tooltip: { callbacks: { label: (ctx) => formatearMoneda(ctx.raw) } },
            },
            scales: {
                x: { beginAtZero: true, ticks: { callback: v => formatearNum(v, 0) } },
            },
        },
    }, "bar");
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw("chartMargenEntidad", () => dibujarGraficoMargenEntidad(ents));
    }
}

// [PBI · 09/09] Gráfica de Margen por Paciente: barras horizontales top 10
// por utilidad (verde positivo / rojo negativo). Datos: margen_por_entidad.
function dibujarGraficoMargenPaciente(ents) {
    const cv = document.getElementById("chartMargenPaciente");
    if (!cv || !ents || !ents.length) return;
    const top = ents.slice().sort((a, b) => (b.utilidad || 0) - (a.utilidad || 0)).slice(0, 10);
    _crearChartTipo("chartMargenPaciente", {
        type: "bar",
        data: {
            labels: top.map(e => String(e.entidad).slice(0, 18)),
            datasets: [{
                label: "Utilidad",
                data: top.map(e => e.utilidad || 0),
                backgroundColor: top.map(e => (e.utilidad || 0) >= 0 ? colorSerie("ingresos") : colorSerie("egresos")),
                borderRadius: 5,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: "y",
            plugins: {
                legend: { display: false },
                title: { display: true, text: "Top 10 pacientes por utilidad", font: { size: 13, weight: "600" } },
                tooltip: { callbacks: { label: (ctx) => formatearMoneda(ctx.raw) } },
            },
            scales: {
                x: { beginAtZero: true, ticks: { callback: v => formatearNum(v, 0) } },
            },
        },
    }, "bar");
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw("chartMargenPaciente", () => dibujarGraficoMargenPaciente(ents));
    }
}

// [P0B · D-3] Navegación: mostrar el cuadro del paciente seleccionado y
// resaltarlo en la lista paralela (el resto queda oculto).
function _verPacienteMargen(idx) {
    document.querySelectorAll('[id^="cuadro-pac-"]').forEach((el, i) => {
        if (el) el.style.display = (i === idx) ? "" : "none";
    });
    document.querySelectorAll('[id^="pac-margen-"]').forEach((el, i) => {
        if (!el) return;
        if (i === idx) { el.style.borderColor = "var(--zx-ingresos)"; el.style.background = "#f0fdf4"; }
        else { el.style.borderColor = "var(--zn-200)"; el.style.background = "#fff"; }
    });
}

// [PRIORIDAD 0 · LISTA DUEÑO §2] Margen por Procedimiento: réplica del Excel
// "MARGEN POR PROCEDIMIENTO" derivada de la matriz (columna Procedimiento).
// Misma estructura que margen_entidad: tabla + gráfico de utilidad.
function renderizarMargenProcedimiento(margenProc) {
    const wrap = document.getElementById("wrap-margen-procedimiento");
    const wrapDet = document.getElementById("wrap-margen-procedimiento-detalle");
    const tbl = document.getElementById("tabla-margen-procedimiento");
    if (!tbl) return;
    const ents = (margenProc && margenProc.entidades) || [];
    if (!ents.length) {
        if (wrap) wrap.classList.add("d-none");
        if (wrapDet) wrapDet.classList.add("d-none");
        return;
    }
    if (wrap) wrap.classList.remove("d-none");
    if (wrapDet) wrapDet.classList.remove("d-none");
    let html = '<thead><tr><th>Procedimiento</th><th class="num">Ingresos</th><th class="num">Egresos</th><th class="num">Utilidad</th><th class="num">Margen %</th></tr></thead><tbody>';
    ents.forEach(e => {
        const cu = e.utilidad >= 0 ? "#059669" : "#dc2626";
        html += '<tr><td>' + String(e.entidad).slice(0, 32) + '</td>' +
                '<td class="num">' + formatearMoneda(e.ingresos) + '</td>' +
                '<td class="num">' + formatearMoneda(e.egresos) + '</td>' +
                '<td class="num fw-bold" style="color:' + cu + '">' + formatearMoneda(e.utilidad) + '</td>' +
                '<td class="num">' + (e.margen_pct === null ? "—" : e.margen_pct + "%") + '</td></tr>';
    });
    html += '</tbody>';
    tbl.innerHTML = html;
    dibujarGraficoMargenProcedimiento(ents);
}

function dibujarGraficoMargenProcedimiento(ents) {
    const cv = document.getElementById("chartMargenProcedimiento");
    if (!cv) return;
    const top = ents.slice(0, 12);
    _crearChartTipo("chartMargenProcedimiento", {
        type: "bar",
        data: {
            labels: top.map(e => String(e.entidad).slice(0, 18)),
            datasets: [{
                label: "Utilidad",
                data: top.map(e => e.utilidad),
                backgroundColor: top.map(e => e.utilidad >= 0 ? colorSerie("ingresos") : colorSerie("egresos")),
                borderRadius: 5,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: "y",
            plugins: {
                legend: { display: false },
                title: { display: true, text: "Utilidad por Procedimiento", font: { size: 13, weight: "600" } },
                tooltip: { callbacks: { label: (ctx) => formatearMoneda(ctx.raw) } },
            },
            scales: {
                x: { beginAtZero: true, ticks: { callback: v => formatearNum(v, 0) } },
            },
        },
    }, "bar");
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw("chartMargenProcedimiento", () => dibujarGraficoMargenProcedimiento(ents));
    }
}

// [F2.3] Anio vs Anio: agrupa saldos por mes y compara dos periodos.
// Se apoya en business._serie_mensual_saldo (si existe) o calcula desde el df.

// [Frente C · E3+] Análisis financiero detallado para tab Avanzado
function renderizarAdvFinanciero(biz) {
    const grid = document.getElementById("adv-fin-grid");
    const dosCol = document.getElementById("adv-dos-col");
    if (!grid || !dosCol) return;
    if (!biz || biz.total_ingresos === undefined) {
        grid.classList.add("d-none");
        dosCol.classList.add("d-none");
        return;
    }
    grid.classList.remove("d-none");
    dosCol.classList.remove("d-none");
    const ing = biz.total_ingresos || 0;
    const egr = biz.total_egresos || 0;
    const saldo = biz.margen_neto || 0;
    const pct = ing > 0 ? ((saldo / ing) * 100).toFixed(1) : "0.0";
    setFinText("adv-fin-ingresos", formatearMoneda(ing));
    setFinText("adv-fin-ing-sub", (biz.n_ingresos || 0) + " operaciones");
    setFinText("adv-fin-egresos", formatearMoneda(egr));
    setFinText("adv-fin-egr-sub", (biz.n_egresos || 0) + " egresos");
    setFinText("adv-fin-saldo", formatearMoneda(saldo));
    setFinText("adv-fin-sal-sub", pct + "% del ingreso");
    setFinText("adv-fin-pct", pct + "%");
    pintarTablaResumen("adv-tabla-res-ing", biz.ingresos_por_categoria, "Ingreso", ing);
    pintarTablaResumen("adv-tabla-res-egr", biz.egresos_por_categoria, "Egreso", egr);
}

// --- Carga principal ---
async function cargarDashboard(id) {
    mostrarSpinner(true);
    // [O-5] Con dataset activo, retirar el estado vacío
    ocultarEstadoVacio();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
        const params = new URLSearchParams();
        // CORRECCIÓN (Fundacional §6.1 — Capa 1): enviar columna_x/columna_y
        // al backend. Sin estos parámetros, obtener_analytics() no calcula
        // KPIs ni serie de gráfico (services.py: if columna_y: ... else: ...).
        if (_ejeXActual) params.set("columna_x", _ejeXActual);
        if (_ejeYActual) params.set("columna_y", _ejeYActual);
        // [Fase O-3 §2.6] Meta del período → kpis.meta/porcentaje_meta en el backend
        if (_metaActual !== null && _metaActual !== undefined) params.set("meta", String(_metaActual));
        // [Frente C · E3] Filtros financieros globales (mes/tipo)
        if (_filtroMesActual) params.set("mes", _filtroMesActual);
        if (_filtroTipoActual) params.set("tipo", _filtroTipoActual);
        // [Fase 4] Rango por CALENDARIO (fechas reales día a día)
        if (_filtroFechaDesde) params.set("fecha_desde", _filtroFechaDesde);
        if (_filtroFechaHasta) params.set("fecha_hasta", _filtroFechaHasta);

        // [Fix C-1] Filtro de "Categorías visibles". Cargar la config del bloque
        // ANTES del GET principal para que `excluir` refleje las categorías
        // desmarcadas desde la primera carga (no solo tras un toggle). El
        // backend excluye en memoria (§6.1) y así KPIs, serie, tabla, anomalías
        // y margen quedan consistentes en un solo request.
        let configBloque = {};
        try {
            configBloque = (await cargarConfigBloque(id)) || {};
        } catch (_) { configBloque = {}; }
        _modulosVisiblesActual = configBloque.modulos_visibles || {};
        // [FIX 23/08] Las claves "col:X" son toggles de COLUMNAS del dataset
        // (ocultan módulos/secciones), NO categorías: enviarlas como `excluir`
        // hacía que el backend intentara filtrar valores inexistentes.
        const catsOcultas = Object.keys(_modulosVisiblesActual)
            .filter(k => _modulosVisiblesActual[k] === false && !k.startsWith("col:"));
        // [Fase dedup · FIX] Series globales apagadas (__ingresos/__egresos)
        // → excluir sus VALORES en la columna Tipo vía C-1 multi-columna.
        if (_modulosVisiblesActual["__ingresos"] === false) {
            catsOcultas.push("ingreso", "ingresos");
        }
        if (_modulosVisiblesActual["__egresos"] === false) {
            catsOcultas.push("egreso", "egresos");
        }
        if (catsOcultas.length) params.set("excluir", catsOcultas.join(","));

        const res = await fetch(`/api/dashboard/${id}?${params.toString()}`, {
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const codigo = err.codigo || "DEFAULT";

            // R10 — Manejo especifico de 422 (mapeo invalido o sin configurar)
            if (res.status === 422 || codigo === "MAPEO_INVALIDO") {
                const banner = document.getElementById("banner-mapeo-pendiente");
                if (banner) banner.classList.remove("d-none");
                mostrarSpinner(false);
                return;
            }

            // R10 — PARQUET_FALTANTE: mostrar banner Y modal de reconstruccion
            if (codigo === "PARQUET_FALTANTE") {
                mostrarError(codigo);
                mostrarSpinner(false);
                return;
            }

            mostrarError(codigo);
            mostrarSpinner(false);
            return;
        }

        const data = await res.json();
        // [R-3b] Exponer analytics globalmente para el drawer de personalización
        window.__zenit_analytics = data;
        // [Fase L-1] Si el backend resolvió los ejes automáticamente en este
        // request (sin columna_x/columna_y), usarlos directamente para que los
        // selectores queden sincronizados SIN recargar ni parpadear.
        if (data.ejes_auto_usados && data.ejes_auto_usados.columna_y) {
            _ejeXActual = data.ejes_auto_usados.columna_x || null;
            _ejeYActual = data.ejes_auto_usados.columna_y || null;
        }
        // [Plan B v1.0.0] Cargar config REAL antes de renderizar —
        // /api/dashboard/<id> NO incluye config (Plan E no lo expone).
        // Si no se inyecta acá, colores, módulos visibles y demás
        // personalización se pierden en cada recarga.
        // [Fix C-1] Reutilizar `configBloque` ya descargado arriba (evita un
        // segundo fetch y garantiza que los checkboxes respeten el mismo
        // modulos_visibles que el filtro `excluir` del GET).
        data.config = configBloque;
        // [O-6] Ficha de contexto del dataset (metadatos del bloque)
        try {
            const metaRes = await fetch(`/api/tabla/${id}`);
            if (metaRes.ok) renderizarFichaContexto(await metaRes.json(), data);
        } catch (_) { /* no romper si falla la ficha */ }
        // [P-13] Panel de calidad de datos (perfil de columnas)
        try { renderizarCalidadDatos(data); } catch (_) {}
        // [P-14] Estadística orientada al negocio (margen % + ticket)
        try { renderizarStatsNegocio(data.business || {}); } catch (_) {}
        // [Frente C · E5] Moneda dinámica desde el bloque
        if (data.moneda) _monedaActual = data.moneda;
        // [Fase 0 · T0.1b] Pipeline de render protegido: si un módulo de render
        // falla, NO saltamos al catch genérico (que mostraría error falso) ni
        // perdemos Registros/rankings — el fallo queda en consola.
        try {
        // [Frente C · E3] Poblar filtros financ. (Mes/Tipo) y mostrar barra si hay I/E
        poblarFiltrosFinancieros(data);
        // [Frente C · E5+] Tarjetas financieras principales (réplica del Excel)
        renderizarFinPrincipal(data.business || {});
        // [Frente C · E3+] Análisis financiero detallado para tab Avanzado
        renderizarAdvFinanciero(data.business || {});
        // [Frente C · F2.5] Desglose automático por Concepto
        renderizarDesgloseConcepto(data.business && data.business.modulos_derivados);
    renderizarSubtablasCategorias(data.business && data.business.modulos_derivados); // [B2-B8]
        // [B-2] Margen por Entidad (paciente/procedimiento)
        renderizarMargenEntidad(data.business && data.business.margen_por_entidad);
        // [PRIORIDAD 0 · LISTA DUEÑO §2] Margen por Procedimiento (derivado de
        // la matriz, columna Procedimiento) — card propia.
        renderizarMargenProcedimiento(data.business && data.business.margen_por_procedimiento);
        // [Frente C · E4-dims] Explorador por dimensión — [T-1 31/08] NO se
        // dibuja en Resumen (son tablas de detalle por dimensión; Resumen =
        // solo BI). La función queda viva para quien la invoque en otro tab.
        _businessActual = data;
        const _dimsWrap = document.getElementById("wrap-dims-financieras");
        if (_dimsWrap) _dimsWrap.classList.add("d-none");
        if (_dimsWrap) _dimsWrap.innerHTML = "";
        actualizarUI(data);
        // aplicarVisibilidadGuardada() que se llamaba aparte es redundante:
        // actualizarUI() ya la aplica en L709 con data.config poblado.
        // [Plan F-2 — Fase 1] Tarjetas dinámicas: rankings/alertas desde
        // el endpoint financiero (solo lectura, aditivo). Si falla, la capa
        // financiera nunca rompe el dashboard genérico.
        try {
            const fin = await fetch(`/api/bloque/${id}/financiero`).then(r => r.json());
            if (fin && fin.rankings && (fin.rankings.top.length || fin.rankings.cero.length)) {
                renderizarRankingsFinancieros(fin.rankings);
            }
            if (fin && fin.alertas_proximidad && fin.alertas_proximidad.conteo > 0) {
                mostrarAlertaProximidad(fin.alertas_proximidad.conteo);
            }
        } catch (_) { /* la capa financiera nunca rompe el dashboard */ }
        cargarGridRegistros(id);
        } catch (renderErr) {
            console.error("[Zenit] Fallo renderizando el dashboard (datos recibidos OK):", renderErr);
        }
        // [Fase E1] Si María Elena eligió "Imprimir Dashboard" en /exportar,
        // [Fase E1] Si María Elena eligió "Imprimir Dashboard" en /exportar,
        // preparamos el dashboard para impresión y abrimos el diálogo:
        //   1. Muestra todos los tabs para que los canvas tengan dimensiones
        //   2. Redimensiona charts Chart.js
        //   3. Convierte canvases a PNG (conserva colores exactos)
        //   4. Inyecta portada profesional con el nombre del dataset
        //   5. Llama window.print() — el CSS @media print hace el resto
        if (_flagImprimir) {
            _flagImprimir = false;
            setTimeout(() => _prepararYImprimir(), 150);
        }
    } catch (e) {
        clearTimeout(timeoutId);
        mostrarError(e.name === "AbortError" ? "TIMEOUT_LIMITE" : "DEFAULT");
    } finally {
        mostrarSpinner(false);
    }
}

// ── Selectores de Eje X / Eje Y (Fundacional §6.1 — Capa 1) ──────────────
function poblarSelectoresEjes(perfilColumnas, kpis) {
    const selX = document.getElementById("sel-eje-x");
    const selY = document.getElementById("sel-eje-y");
    if (!selX || !selY) return;

    // Guardar selección actual antes de repoblar
    const prevX = selX.value;
    const prevY = selY.value;

    // Columnas disponibles: todas las del perfil
    const columnas = Object.keys(perfilColumnas || {});

    // Eje X: columnas de tipo texto/fecha (categorías)
    const colsX = columnas.filter(c => {
        const p = perfilColumnas[c];
        return p && (p.tipo === "texto" || p.tipo === "fecha" || p.tipo === "posible_fecha");
    });

    // Eje Y: columnas numéricas
    const colsY = columnas.filter(c => {
        const p = perfilColumnas[c];
        return p && p.tipo === "numerico";
    });

    // Poblar Eje X
    selX.innerHTML = '<option value="">— Selecciona —</option>';
    colsX.forEach(c => {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        selX.appendChild(opt);
    });

    // Poblar Eje Y
    selY.innerHTML = '<option value="">— Selecciona —</option>';
    colsY.forEach(c => {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        selY.appendChild(opt);
    });

    // [Fase B-UI] Poblar selectores de ratio con columnas numéricas.
    // [L-3a] El panel vive en el tab "Avanzado" (ya no se fuerza display).
    const ratioA = document.getElementById("ratio-col-a");
    const ratioB = document.getElementById("ratio-col-b");
    if (ratioA && ratioB) {
        ratioA.innerHTML = '<option value="">— Col A —</option>';
        ratioB.innerHTML = '<option value="">— Col B —</option>';
        colsY.forEach(c => {
            ratioA.appendChild(new Option(c, c));
            ratioB.appendChild(new Option(c, c));
        });
    }

    // Auto-seleccionar. Prioridad:
    //   1) _ejeXActual/_ejeYActual ya resueltos (por el usuario o por los ejes
    //      automáticos del backend, Fase L-1) → se mantienen sin recargar.
    //   2) selección previa del <select>.
    //   3) columna del KPI actual para Y y primera columna texto/fecha para X.
    let cambioEjes = false;
    if (_ejeXActual && colsX.includes(_ejeXActual)) {
        selX.value = _ejeXActual;
    } else if (prevX && colsX.includes(prevX)) {
        selX.value = prevX;
        _ejeXActual = prevX;
    } else if (colsX.length > 0) {
        selX.value = colsX[0];
        _ejeXActual = colsX[0];
        cambioEjes = true;
    }

    if (_ejeYActual && colsY.includes(_ejeYActual)) {
        selY.value = _ejeYActual;
    } else if (prevY && colsY.includes(prevY)) {
        selY.value = prevY;
        _ejeYActual = prevY;
    } else if (kpis && kpis.columna && colsY.includes(kpis.columna)) {
        selY.value = kpis.columna;
        _ejeYActual = kpis.columna;
    } else if (colsY.length > 0) {
        selY.value = colsY[0];
        _ejeYActual = colsY[0];
        cambioEjes = true;
    }

    // [fix] Auto-selección inteligente: si los ejes cambiaron y es la
    // PRIMERA vez que se auto-seleccionan (no hubo selección previa del
    // usuario), recargar UNA sola vez con los ejes ya elegidos. Después
    // de esa recarga, _ejesAutoSeleccionados=true evita el loop.
    if (cambioEjes && !_ejesAutoSeleccionados && currentTablaId) {
        _ejesAutoSeleccionados = true;
        cargarDashboard(currentTablaId);
    }
}

function cambiarEjeX(valor) {
    _ejeXActual = valor || null;
    if (currentTablaId) cargarDashboard(currentTablaId);
}

// [Fase L-2] Modo experto: mostrar/ocultar los selectores de ejes.
// Los ejes se auto-resuelven al cargar ("importa y ve"); este botón permite
// cambiarlos manualmente cuando sea necesario.
function mostrarSpinner(visible) {
    const sp = document.getElementById("dashboard-spinner");
    if (sp) sp.classList.toggle("d-none", !visible);
}

function ocultarBanner() {
    const b = document.getElementById("error-banner");
    if (b) b.classList.add("d-none");
}

function mostrarError(codigo) {
    const banner = document.getElementById("error-banner");
    const msg = document.getElementById("error-banner-msg");
    let texto = MENSAJES_ERROR[codigo] || MENSAJES_ERROR.DEFAULT;
    if (codigo === "PARQUET_FALTANTE") {
        // CORRECCIÓN (Crítico #9): antes usaba `new bootstrap.Modal(...).show()`,
        // que añade backdrop/scroll-lock propios de Bootstrap. cerrarModalReconstruir()
        // (arriba) cierra con el sistema propio (abrirModal/cerrarModal, solo
        // alterna la clase d-none) y nunca retira ese backdrop — quedaba pegado
        // permanentemente. Ahora se abre con el mismo sistema con el que se cierra.
        texto += ' <button class="btn btn-sm btn-outline-danger fw-bold ms-2" ' +
                 'onclick="abrirModal(\'modalReconstructNative\')">' +
                 'Vincular Excel original</button>';
    }
    msg.innerHTML = texto;
    banner.classList.remove("d-none");
}

// --- Formato ---
// [Frente C · E5] Moneda dinámica desde el bloque (data.moneda) - default "$"
let _monedaActual = "$";

function formatearMoneda(v) {
    if (v === undefined || v === null) return "\u2014";
    return _monedaActual + " " + Number(v).toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatearPct(v) {
    if (v === undefined || v === null) return "\u2014";
    return v.toFixed(2) + "%";
}
function formatearNum(v, dec = 2) {
    if (v === undefined || v === null) return "\u2014";
    // [Frente C · F1-fix] Separador de miles + coma decimal (formato venezolano):
    // 128560 -> "128.560,00". Antes usaba toFixed() sin separador.
    return Number(v).toLocaleString("es-BO", {
        minimumFractionDigits: dec,
        maximumFractionDigits: dec,
    });
}
function setTexto(id, valor) {
    const el = document.getElementById(id);
    if (el) el.textContent = valor;
}

// --- Actualizacion de la UI ---
function actualizarUI(data) {
    // CORRECCIÓN (Alto): mostrarBotonesAccion() está definida en
    // dashboard.html pero nunca se invocaba. Los botones "Exportar PDF" y
    // "Eliminar" quedaban permanentemente ocultos (display:none inline)
    // incluso con un dataset cargado exitosamente.
    if (typeof mostrarBotonesAccion === "function") mostrarBotonesAccion();

    // ── [v5.0.0] Mapeo del contrato Plan E (AnalyticsResult) al formato UI ──
    // El backend del Plan E devuelve data.kpis (suma/promedio/máx/mín/conteo),
    // data.serie_grafico ([{x,y}]) y data.perfil_columnas[<col_y>].estadisticas.
    // Este mapeo los adapta a lo que el resto de actualizarUI() espera,
    // manteniendo retrocompatibilidad con data.business (Plan F/CoreTabla legacy).
    const kpis = data.kpis || null;
    const biz = data.business || {};
    // KPI "total" → kpis.suma (Plan E) o business.total (legacy)
    if (kpis && biz.total === undefined) biz.total = kpis.suma;
    if (kpis && biz.promedio === undefined) biz.promedio = kpis.promedio;
    if (kpis && biz.maximo === undefined) biz.maximo = kpis.maximo;
    if (kpis && biz.minimo === undefined) biz.minimo = kpis.minimo;
    // [Fase O-3 §2.6] Gauge de meta: el contrato moderno trae kpis.porcentaje_meta.
    if (kpis && biz.porcentaje_meta === undefined &&
        kpis.porcentaje_meta !== undefined && kpis.porcentaje_meta !== null) {
        biz.porcentaje_meta = kpis.porcentaje_meta;
        biz.meta = kpis.meta;
    }
    // Serie de gráfico: Plan E la expone en data.serie_grafico
    if (!biz._serie_mensual) {
        const serie = data.serie_grafico || [];
        if (serie.length) {
            biz._serie_mensual = {
                labels: serie.map(p => String(p.x)),
                valores: serie.map(p => Number(p.y)),
            };
            // _categorias_detalle = misma serie (agrupada por columna_x categoría)
            biz._categorias_detalle = { labels: biz._serie_mensual.labels, valores: biz._serie_mensual.valores };
        }
    }
    // Estadísticas descriptivas: Plan E las anida en perfil_columnas[col_y].estadisticas
    let ct = data.central_tendency || {};
    let dp = data.dispersion || {};
    let sh = data.shape || {};
    let pos = data.position || {};
    const perfilY = (kpis && data.perfil_columnas && data.perfil_columnas[kpis.columna]) || null;
    if (perfilY && perfilY.estadisticas) {
        const e = perfilY.estadisticas;
        ct = e.central_tendency || ct;
        dp = e.dispersion || dp;
        sh = e.shape || sh;
        pos = e.position || pos;
    }
    const anom = data.anomalies || [];

    // ── [Fase 0 · T0.1] BLINDAJE POR MÓDULO ──────────────────────────────
    // Cada sección corre aislada: si una falla, queda en consola (visible en
    // el CMD de logs) y el RESTO del dashboard sigue vivo. Antes, una sola
    // excepción a mitad de función abortaba todo lo que venía después en
    // silencio (varias gráficas vacías a la vez sin explicación).
    const _seguro = (nombre, fn) => {
        try { fn(); }
        catch (e) {
            const msg = (e && e.message) || String(e);
            console.error("[Zenit] Módulo «" + nombre + "» falló (el resto sigue vivo):", e);
            // [T0.1-bis] Espejo al CMD del servidor (visible sin F12).
            try {
                fetch("/api/log-frontend", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    keepalive: true,
                    body: JSON.stringify({ contexto: "modulo:" + nombre, mensaje: msg }),
                });
            } catch (_) {}
        }
    };

    // [Fase Ñ-3] Resumen EDA en español arriba del iframe (para gerentes)
    renderizarResumenEDA(data);

    // Poblar selectores de Eje X / Eje Y (Fundacional §6.1 — Capa 1)
    _perfilColumnasActual = data.perfil_columnas || null;
    _kpisActual = kpis;
    poblarSelectoresEjes(data.perfil_columnas, kpis);

    // Cargar colores personalizados desde config (E15 — Sesión 2.1)
    // CORRECCIÓN (Medio): antes solo se reasignaba si el dataset traía
    // colores_categoria guardado, dejando colores "filtrados" desde el
    // dataset anterior. Ahora se resetea siempre, igual que
    // _modulosVisiblesActual en renderizarChipsModulos.
    // [Plan C v1.0.0] Preferir color_por_serie (esquema canónico R22, usado por PDF).
    // colores_categoria es alias retrocompat para datos existentes.
    _coloresCategoriaActual = (data.config && (data.config.color_por_serie || data.config.colores_categoria)) || {};
    // [MOTOR ÚNICO · Fase dedup] Migración automática de llaves legacy
    // "col:<Nombre>" → "<Nombre>": un solo espacio de nombres de colores.
    Object.keys(_coloresCategoriaActual).forEach(k => {
        if (k.startsWith("col:")) {
            const nombre = k.slice(4);
            if (!(nombre in _coloresCategoriaActual)) {
                _coloresCategoriaActual[nombre] = _coloresCategoriaActual[k];
            }
            delete _coloresCategoriaActual[k];
        }
    });



    // ── Aviso de col_tipo no configurado (E2) ──────────────────────────────
    const avisoTipo = document.getElementById("aviso-sin-col-tipo");
    if (avisoTipo) {
        avisoTipo.classList.toggle("d-none", data.tiene_col_tipo !== false);
    }

    // R17 — Mostrar/ocultar banner de mapeo pendiente
    (function() {
        const banner = document.getElementById("banner-mapeo-pendiente");
        if (!banner) return;

        // Determinar si el mapeo esta pendiente
        let mapPendiente = false;

        // Opcion A: el config de la tabla tiene el flag
        if (data.config) {
            try {
                const cfg = typeof data.config === "string"
                    ? JSON.parse(data.config)
                    : data.config;
                mapPendiente = cfg.mapeo_pendiente === true;
            } catch (_) {}
        }

        // [fix] El banner "Configuración de análisis pendiente" SOLO debe
        // mostrarse si el config del bloque tiene mapeo_pendiente=true
        // (es decir, el usuario realmente no tiene col_monto configurado).
        // NO debe mostrarse solo porque kpis es null (primera carga sin
        // ejes seleccionados). El profiler ya autodetecta las columnas.

        if (mapPendiente) {
            banner.classList.remove("d-none");
        } else {
            banner.classList.add("d-none");
        }

        // R4 — Si viene de una importación reciente sin mapeo, solo mostrar el
        // banner no bloqueante. NO abrir el modal automáticamente (Fundacional
        // §1.3: "ningún otro diálogo modal bloqueante se añade fuera de los 3
        // pasos"). El usuario configura columnas solo si lo desea explícitamente.
        if (sessionStorage.getItem("zenit_aviso_mapeo_pendiente") === "true") {
            sessionStorage.removeItem("zenit_aviso_mapeo_pendiente");
        }
    })();

    // ── Determinar modo (clínica vs estándar) ───────────────────────────────
    // [L-3b] También se activa con `data.margen_automatico` (margen Ingreso−Egreso
    // detectado automáticamente por el backend sobre CoreBloque moderno).
    const ma = data.margen_automatico || null;
    const modoClinica = (
        (biz.total_ingresos !== undefined && biz.total_egresos !== undefined) ||
        !!(ma && ma.ingresos !== undefined && ma.egresos !== undefined)
    );

    // Referencias a tarjetas de clínica
    const cardTotal    = document.getElementById("kpi-card-total");
    const cardIngresos = document.getElementById("kpi-card-ingresos");
    const cardEgresos  = document.getElementById("kpi-card-egresos");
    const cardMargen   = document.getElementById("kpi-card-margen-neto");
    const wrapDonutIng = document.getElementById("wrap-donut-ingresos");
    const wrapDonutEgr = document.getElementById("wrap-donut-egresos");

    if (modoClinica) {
        // ── MODO CLÍNICA: mostrar tarjetas segmentadas ───────────────────
        // Fuente de datos: margen automático (CoreBloque) o business legacy.
        const ing = ma ? ma.ingresos : biz.total_ingresos;
        const egr = ma ? ma.egresos : biz.total_egresos;
        const nIng = ma ? (ma.n_ingresos || 0) : (biz.n_ingresos || 0);
        const nEgr = ma ? (ma.n_egresos || 0) : (biz.n_egresos || 0);
        const margen = ma ? ma.margen : (biz.margen_neto || 0);

        _seguro("Tarjetas financieras + Tendencia", () => {
        // ── [Fase dedup] Flags de series globales para este render ──
    const ingOff = _modulosVisiblesActual["__ingresos"] === false;
    const egrOff = _modulosVisiblesActual["__egresos"] === false;

    if (cardTotal)    cardTotal.classList.add("d-none");
    if (cardIngresos) cardIngresos.classList.toggle("d-none", ingOff);
    if (cardEgresos)  cardEgresos.classList.toggle("d-none", egrOff);
    if (cardMargen)   cardMargen.classList.toggle("d-none", ingOff || egrOff);

        const setEl = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };

        setEl("kpi-val-ingresos",  formatearMoneda(ing));
        setEl("kpi-cnt-ingresos",  `${nIng} operaciones`);
        setEl("kpi-val-egresos",   formatearMoneda(egr));
        setEl("kpi-cnt-egresos",   `${nEgr} egresos`);

        const elMargen = document.getElementById("kpi-val-margen-neto");
        if (elMargen) {
            elMargen.textContent = formatearMoneda(margen);
            elMargen.className   = `fw-bold mt-2 ${margen >= 0 ? "text-success" : "text-danger"}`;
        }
        const pct = biz.pct_margen !== undefined
            ? `${biz.pct_margen}% del ingreso total`
            : `${ing > 0 ? ((margen / ing) * 100).toFixed(1) : "0.0"}% del ingreso total`;
        setEl("kpi-pct-margen", pct);

        // Gráfico tendencia por período (Mensual | Anual | Rango).
        // El rango ya viene recortado en las series por el backend.
        // [T0.2 · Fase 0] Si quedó "Anual" persistido pero este bloque no tiene
        // serie anual (sin columna Fecha), volver a Mensual automáticamente.
        if (_tendenciaPeriodo === "anio" && !biz._serie_anual_ingresos) {
            _tendenciaPeriodo = "mes";
            try { sessionStorage.setItem("zenit_tend_periodo", "mes"); } catch (_) {}
            const selTendSync = document.getElementById("sel-tendencia-periodo");
            if (selTendSync) selTendSync.value = "mes";
        }
        const usarAnual = (_tendenciaPeriodo === "anio") && !!biz._serie_anual_ingresos;
        const sIng = usarAnual ? biz._serie_anual_ingresos : biz._serie_mensual_ingresos;
        const sEgr = usarAnual ? biz._serie_anual_egresos : biz._serie_mensual_egresos;
        const sMg  = usarAnual ? (biz._serie_anual_margen || null) : (biz._serie_mensual_margen || null);
        if (sIng && sEgr) {
            dibujarGraficoIngresosEgresos(sIng, sEgr, sMg);
        } else {
            // [T0.3 · Fase 0] Diagnóstico visible del motivo exacto.
            console.warn("[Zenit] Tendencia sin dibujar → motivo:", {
                periodo: _tendenciaPeriodo,
                tiene_mensual: !!biz._serie_mensual_ingresos,
                tiene_anual: !!biz._serie_anual_ingresos,
                modoClinica,
            });
            _destruirChart("mainTrendChart");
            mostrarPlaceholderGrafico("mainTrendChart",
                "Tendencia no disponible: se requiere una columna de Fecha/Mes y Monto con Ingresos y Egresos.");
        }

        });

        _seguro("Donuts I/E + chips de categorías", () => {
        // Donut ingresos por categoría
        const ingCat = biz.ingresos_por_categoria;
        if (Array.isArray(ingCat) && ingCat.length > 0) {
            if (wrapDonutIng) wrapDonutIng.classList.remove("d-none");
            dibujarGraficoDonutCategorias(
                "chartIngCategorias",
                ingCat,
                "Ingresos por procedimiento",
            );
        }

        // Donut egresos por categoría
        const egrCat = biz.egresos_por_categoria;
        if (Array.isArray(egrCat) && egrCat.length > 0) {
            if (wrapDonutEgr) wrapDonutEgr.classList.remove("d-none");
            dibujarGraficoDonutCategorias(
                "chartEgrCategorias",
                egrCat,
                "Composición de egresos",
            );
        }

        // Tabla Pareto (E9) — con datos de ingresos
        if (Array.isArray(ingCat) && ingCat.length > 0) {
            renderizarTablaPareto(ingCat);
        }

        // Chips de categorías visibles (E4, E5, E14)
        // [Fix C-1] El catálogo completo llega en data.categorias_disponibles
        // (el backend ya excluyó en memoria antes de KPIs/serie). Aquí solo se
        // pasan los datos con % para que los chips muestren la proporción real;
        // las categorías desmarcadas siguen visibles y se pueden volver a marcar.
        const categoriasParaChips = (biz.ingresos_por_categoria || []).concat(biz.egresos_por_categoria || []);
        renderizarChipsModulos(categoriasParaChips, data.config || {}, data.categorias_disponibles);
        });

        // [PRIORIDAD 0 · LISTA DUEÑO §5] Resumen mensual + comparativa anual
        // (Mes × Consultas/Cirugías/I/E/Margen/Margen% + promedio + vs Meta).
        _seguro("Resumen mensual + comparativa anual", () => {
            renderizarResumenMensual(biz, data.kpis ? data.kpis.meta : null);
        });
        // [R-4 · 28/08] Insights: conclusiones automáticas en texto.
        _seguro("Insights", () => {
            renderizarInsights(data);
        });

    } else {
        // ── MODO ESTÁNDAR: ocultar tarjetas de clínica ──
        if (cardTotal)    cardTotal.classList.remove("d-none");
        if (cardIngresos) cardIngresos.classList.add("d-none");
        if (cardEgresos)  cardEgresos.classList.add("d-none");
        if (cardMargen)   cardMargen.classList.add("d-none");
        if (wrapDonutIng) wrapDonutIng.classList.add("d-none");
        if (wrapDonutEgr) wrapDonutEgr.classList.add("d-none");

        _destruirChart("chartIngCategorias");
        _destruirChart("chartEgrCategorias");
    }

    // Capa 1: KPIs (solo se actualizan en modo estándar)
    _seguro("KPIs · Gauge · Narrata · Estadísticas · Cuartiles · Box", () => {
    if (!modoClinica) {
        setTexto("kpi-val-total", formatearMoneda(biz.total));
    }
    setTexto("kpi-val-promedio", formatearMoneda(biz.promedio));
    // [T1 · FIX] Label dinámico derivado del nombre de la columna Y (antes
    // hardcodeaba "Ticket Promedio" — residuo del Excel de ejemplo).
    const colY = _ejeYActual || _columnaYDefecto || "—";
    const lblProm = document.getElementById("kpi-label-promedio");
    if (lblProm) lblProm.textContent = "Promedio de " + String(colY);
    setTexto("kpi-val-crecimiento",
        biz.crecimiento_mensual !== undefined ? formatearPct(biz.crecimiento_mensual) : "\u2014");
    setTexto("kpi-val-proyeccion",
        biz.proyeccion_proximo_mes !== undefined ? formatearMoneda(biz.proyeccion_proximo_mes) : "\u2014");

    // Gauge de meta (condicional)
    const gaugeCard = document.getElementById("kpi-card-meta");
    // CORRECCIÓN (Crítico): null-guard en gaugeCard, gauge-fill y gauge-text.
    // gauge-fill/gauge-text NO EXISTEN en dashboard.html actualmente (solo
    // existe kpi-val-meta, que tampoco se actualizaba). Sin este guard,
    // cualquier dataset con porcentaje_meta configurado abortaba
    // actualizarUI() a mitad de camino sin ningún error visible.
    // PENDIENTE (no resuelto en este parche): el SVG del gauge no está
    // implementado en el HTML — ver Task 09 (requiere decisión de diseño).
    if (gaugeCard && biz.porcentaje_meta !== undefined && biz.porcentaje_meta !== null) {
        gaugeCard.classList.remove("d-none");
        const pMeta = Math.min(Math.max(biz.porcentaje_meta, 0), 100);
        const gaugeFill = document.getElementById("gauge-fill");
        const gaugeText = document.getElementById("gauge-text");
        if (gaugeFill) gaugeFill.style.strokeDashoffset = 125.6 - (125.6 * pMeta / 100);
        if (gaugeText) gaugeText.textContent = Math.round(pMeta) + "%";
        setTexto("kpi-val-meta", Math.round(pMeta) + "%");
    } else if (gaugeCard) {
        gaugeCard.classList.add("d-none");
    }

    // Narrativa
    // [Plan E/G] Ocultar la narrativa provisional del primer request (sin
    // ejes X/Y seleccionados): el backend devuelve un texto genérico que
    // parpadea antes de la auto-selección de ejes. La narrativa real llega
    // con la recarga posterior y es la que se muestra al usuario.
    // [R-4] El Resumen muestra SOLO 1-2 frases destacadas (callout morado);
    // el párrafo completo vive en el tab 💡 Insights (insights-resumen).
    const narrativaTexto = data.narrative || "Sin inferencia disponible.";
    if (!narrativaTexto.startsWith("Este bloque tiene")) {
        setTexto("narrative-text", _extraerFrasesDestacadas(narrativaTexto));
    }

    // Capa 2: estadisticas descriptivas
    // [Plan M] contexto: n (conteo de la columna), suma total y subtítulo de columna
    setTexto("stat-n",     kpis ? formatearNum(kpis.conteo, 0) : "—");
    setTexto("stat-suma",  kpis ? formatearMoneda(kpis.suma) : "—");
    setTexto("stat-mean",     formatearMoneda(ct.mean));
    setTexto("stat-median",   formatearMoneda(ct.median));
    setTexto("stat-mode",     ct.mode !== null ? formatearMoneda(ct.mode) : "\u2014");
    setTexto("stat-rango",    formatearMoneda(dp.range));
    setTexto("stat-variance", formatearNum(dp.variance));
    setTexto("stat-std",      formatearNum(dp.std_dev));
    setTexto("stat-cv",       formatearPct(dp.cv));
    setTexto("stat-skew",     formatearNum(sh.skewness, 4));
    setTexto("stat-kurt",     formatearNum(sh.kurtosis, 4));

    // [Plan M-2] subtítulo "Sobre la columna «X»" en el tab de estadísticas
    const statsColumnaEl = document.getElementById("stats-columna");
    if (statsColumnaEl) {
        statsColumnaEl.textContent = (kpis && kpis.columna)
            ? `Sobre la columna «${kpis.columna}»`
            : "";
    }

    // Capa 3: posicion (Q1/Q3/IQR + deciles — dict, NO array)
    // [Plan F] Mostrar contexto: subtítulo con columna, tooltips, placeholder sin datos
    const subtituloEl = document.getElementById("cuartiles-subtitulo");
    const placeholderEl = document.getElementById("cuartiles-placeholder");
    const datosEl = document.getElementById("cuartiles-datos");
    const tienePosicion = pos && pos.q1 !== undefined && pos.q1 !== null;

    if (subtituloEl) {
        subtituloEl.textContent = tienePosicion && _ejeYActual
            ? `Sobre la columna «${_ejeYActual}»`
            : "";
    }
    if (placeholderEl && datosEl) {
        placeholderEl.classList.toggle("d-none", tienePosicion);
        datosEl.style.display = tienePosicion ? "" : "none";
    }

    setTexto("stat-q1",  tienePosicion ? formatearMoneda(pos.q1) : "\u2014");
    setTexto("stat-q3",  tienePosicion ? formatearMoneda(pos.q3) : "\u2014");
    setTexto("stat-iqr", tienePosicion ? formatearMoneda(pos.iqr) : "\u2014");

    const decileCont = document.getElementById("decile-container");
    decileCont.innerHTML = "";
    Object.entries(pos.deciles || {}).forEach(([clave, valor]) => {
        const pct = parseInt(clave.replace("D", ""), 10) * 10;
        // [Plan N-1] de tooltip a texto visible: cada decil muestra qué % está por debajo
        decileCont.innerHTML += `
            <div class="z-decile-item">
                <div class="z-decile-key">${clave}</div>
                <div class="z-decile-val">${formatearNum(valor, 0)}</div>
                <div class="z-decile-desc">el ${pct}% abajo</div>
            </div>`;
    });

    // Box plot — siempre disponible con campos del contrato base
    dibujarBoxPlot(biz.minimo, pos.q1, ct.median, pos.q3, biz.maximo);
    });

    _seguro("Tendencia genérica + Pareto + Hist/Ojiva + Anomalías", () => {

    // [FIX T0.4 · Fase 0] Tendencia genérica SOLO en modo estándar.
    // BUG RAÍZ "Tendencia vacía": este bloque legacy corría SIEMPRE y, en
    // modo clínico (existe _serie_mensual_ingresos), caía al else y pintaba
    // el placeholder ENCIMA de la tendencia financiera recién dibujada.
    if (!modoClinica) {
        if (biz._serie_mensual) {
            dibujarGraficoTrend(biz._serie_mensual.labels, biz._serie_mensual.valores);
        } else {
            mostrarPlaceholderGrafico("mainTrendChart", "Tendencia mensual no disponible (requiere extension de Plan E, ver Apendice 1bis).");
        }
    }
    // En modo clínica la tendencia YA fue dibujada arriba — no se pisa.

    if (biz._categorias_detalle) {
        dibujarParetoChart(biz._categorias_detalle.labels, biz._categorias_detalle.valores);
        // [Plan D v1.0.0] Construir tabla Pareto CON operaciones (n) y % reales.
        // Phase B ya agregó el campo n a PuntoSerie → lo usamos directamente.
        const serie = data.serie_grafico || [];
        const totalSerie = serie.reduce((s, p) => s + Number(p.y), 0);
        const datosConOperaciones = serie.map(p => ({
            categoria: String(p.x),
            monto: Number(p.y),
            operaciones: (p.n !== undefined) ? p.n : 0,
            porcentaje: totalSerie > 0 ? ((Number(p.y) / totalSerie) * 100).toFixed(1) : 0,
        }));
        // Fallback: si no hay serie_grafico, usar _categorias_detalle (sin n, % calculado)
        const datosFallback = (biz._categorias_detalle.labels || []).map((lb, i) => {
            const v = Number(biz._categorias_detalle.valores[i]);
            const totVals = biz._categorias_detalle.valores.reduce((a, b) => a + Number(b), 0);
            return {
                categoria: String(lb),
                monto: v,
                operaciones: 0,
                porcentaje: totVals > 0 ? ((v / totVals) * 100).toFixed(1) : 0,
            };
        });
        const datosPareto = datosConOperaciones.length ? datosConOperaciones : datosFallback;
        renderizarTablaPareto(datosPareto);
        // [Plan D] Actualizar título con el nombre real de la columna Y
        const tituloPareto = document.getElementById('titulo-tabla-pareto');
        if (tituloPareto && _ejeYActual) {
            tituloPareto.textContent = `Top categorías — ${_ejeYActual}`;
        }
        const chipsData = datosPareto.map(c => ({ categoria: c.categoria, porcentaje: c.porcentaje }));
        // [Fix C-1] data.categorias_disponibles trae el catálogo completo de
        // columna_x (incluye las desmarcadas) para poder volver a marcarlas.
        if (chipsData.length || (data.categorias_disponibles || []).length) {
            renderizarChipsModulos(chipsData, data.config || {}, data.categorias_disponibles);
        }
        // [Fase A-2b] Dona de distribución de la columna de agrupación (Eje X).
        // Reutiliza dibujarGraficoDonutCategorias existente — no se crea nueva
        // función de gráfico. Convierte la serie [{x,y}] al formato {categoria, monto}.
        const datosDona = (data.serie_grafico || []).map(p => ({
            categoria: String(p.x),
            monto: Number(p.y),
        }));
        const wrapDona = document.getElementById("wrap-donut-ingresos");
        if (wrapDona && datosDona.length) {
            wrapDona.classList.remove("d-none");
            dibujarGraficoDonutCategorias("chartIngCategorias", datosDona, "Distribución por categoría");
        }
    } else {
        mostrarPlaceholderGrafico("paretoChart", "Detalle por categoria no disponible (requiere extension de Plan E, ver Apendice 1bis).");
    }

    // [Plan F-2 — Fase 1] Histograma/Ojiva con datos reales.
    // FIX 23/08: la clave biz._serie_mensual YA NO EXISTE (ahora son
    // _serie_mensual_*), lo que dejaba el histograma y la ojiva SIEMPRE
    // vacíos. Cadena de fuentes: se usa la MÁS LARGA entre el margen
    // mensual (modo financiero) y los valores del Eje Y agregados por
    // X (serie_grafico).
    const _candidatosHist = [];
    const sMgHist = biz._serie_mensual_margen;
    if (sMgHist && Array.isArray(sMgHist.valores)) {
        _candidatosHist.push(sMgHist.valores.filter(v => Number(v) !== 0));
    }
    if (Array.isArray(data.serie_grafico) && data.serie_grafico.length >= 2) {
        _candidatosHist.push(
            data.serie_grafico.map(p => Number(p && p.y)).filter(Number.isFinite)
        );
    }
    const valoresY = _candidatosHist.length
        ? _candidatosHist.reduce((a, b) => (b.length > a.length ? b : a))
        : [];
    if (valoresY.length >= 2) {
        const hist = crearBins(valoresY, 8);
        dibujarHistograma(hist.bins, hist.frecuencias);
        dibujarOjiva(hist.bins, hist.frecuencias);
    } else {
        mostrarPlaceholderGrafico("histogramChart", "Histograma no disponible: selecciona una columna numérica como Eje Y.");
        mostrarPlaceholderGrafico("ojivaChart", "Ojiva no disponible: selecciona una columna numérica como Eje Y.");
    }

    // Anomalias
    inicializarAgGridAnomalies(anom);
    });

    _seguro("Visibilidad + Plantilla + Comparativa + Alertas + Proyecciones", () => {

    // Visibilidad persistida (config de CoreTabla)
    aplicarVisibilidadGuardada(data.config || {});
    // [Fase O-3] Barra de módulos con el estado guardado
    renderizarBarraModulos(data.config || {});
    // [Fase Q-1] Aviso opcional de plantilla por dominio (descartable)
    gestionarAvisoPlantilla(data);

    // [T-1 · 31/08] Semáforo de meta + Top 5 del Resumen (bloque seguro propio:
    // si falla, el resto del dashboard sigue vivo — patrón T0.1).
    _seguro("Semáforo de meta + Top 5 + Benchmark + Badge + Donut CC + Ticket", () => {
        renderizarSemaforoMeta(kpis);
        renderizarTop5(biz);
        renderizarBadgeHeader(data);
        renderizarBenchmarkMargen(biz);
        renderizarTicketStrip(biz);
        renderizarDonutConsultasCirugias(biz);
        dibujarSparklines(biz);
        // [P-9 · P-11] Flujo de caja + Insights extendidos (texto)
        renderizarFlujoCaja(biz);
        renderizarInsightsExtendidos(biz);
        // [G-FASE 3 · 09/09] Panel compañero de Tendencia: Mejor/Peor mes
        renderizarMejorPeorMes(biz);
        // [P-10] Heatmap de estacionalidad (mes × métrica)
        renderizarHeatmap(biz);
        // [P-12b] Ingresos vs Egresos por categoría (barras agrupadas)
        renderizarIECategoria(biz);
    });

    // Comparativa interanual (Alto #10 — feature ghost)
    // CORRECCIÓN (Crítico): bloque duplicado eliminado. Además se agrega
    // guard defensivo porque mostrarComparativa() no está implementada en
    // este archivo. Sin el guard, un ReferenceError aquí abortaba
    // actualizarUI() completa de forma silenciosa (el usuario solo veía
    // el mensaje genérico "no se pudo procesar la información").
    if (data.comparativa && typeof mostrarComparativa === "function") {
        mostrarComparativa(data.comparativa);
    }

    // Alertas configurables (E18)
    evaluarAlertas(data.config || {}, data.business || {});

    // ── [Fase 6 · FIX] PROYECCIÓN: depende de DATOS, no de elementos inexistentes.
    // BUG: todo colgaba de btnProy (tab-btn-proyecciones NO existe en el HTML)
    // -> con btnProy=null nada se llenaba y el card quedaba vacío siempre.
    // Ahora: la fuente de verdad es business.proyeccion_series (series mensuales
    // I/E/Margen ya filtradas por el calendario) + tendencia como complemento.
    const serie = data.serie_grafico || [];
    const proyS = (data.business || {}).proyeccion_series || {};
    const proyTemporal = proyS.margen || proyS.ingresos || proyS.egresos || null;
    const tieneProyeccion = !!(proyTemporal && proyTemporal.periodos);

    // Textos de dirección/pendiente/próximo desde la serie TEMPORAL real.
    if (tieneProyeccion) {
        setTexto("proyeccion-direccion",
            `Dirección: ${proyTemporal.direccion || "—"}`);
        setTexto("proyeccion-pendiente",
            proyTemporal.pendiente !== null && proyTemporal.pendiente !== undefined
                ? `Pendiente: ${formatearMoneda(proyTemporal.pendiente)} por período` : "—");
        if (proyTemporal.proximo !== null && proyTemporal.proximo !== undefined) {
            setTexto("proyeccion-valor", formatearMoneda(Math.max(0, proyTemporal.proximo)));
            setTexto("proyeccion-nota",
                `Basado en ${proyTemporal.periodos} períodos del rango seleccionado (proyección preliminar).`);
        }
    } else if (serie.length >= 3) {
        // Fallback: dataset genérico sin series financieras.
        const tendencia = data.tendencia || {};
        setTexto("proyeccion-direccion", tendencia.direccion ? `Dirección: ${tendencia.direccion}` : "—");
        setTexto("proyeccion-pendiente", tendencia.pendiente !== undefined
            ? `Pendiente: ${formatearMoneda(tendencia.pendiente)} por período` : "—");
        if (serie.length > 0 && tendencia.pendiente !== undefined) {
            const ultimo = serie[serie.length - 1];
            setTexto("proyeccion-valor", formatearMoneda(Math.max(0, Number(ultimo.y) + Number(tendencia.pendiente))));
            setTexto("proyeccion-nota", `Basado en ${serie.length} períodos históricos (proyección preliminar).`);
        }
    }

        // [Fase 6 · FIX REAL] GRÁFICA de proyección.
    // BUG: se usaba proyeccion_series.* que NO tiene .valores (solo escalares
    // periodos/promedio/acumulado/direccion/pendiente/proximo) -> TypeError
    // al leer serieProy.valores.length -> la gráfica NUNCA se dibujaba (vacía).
    // El HISTÓRICO se toma de business._serie_mensual_* (tiene .valores) y el
    // PUNTO PROYECTADO de proyeccion_series.*.proximo.
    const _proyChart = document.getElementById("proyeccionChart");
    if (_proyChart) {
        const serieHist = biz._serie_mensual_margen || biz._serie_mensual_ingresos || biz._serie_mensual_egresos;
        const proyKey = biz._serie_mensual_margen ? "margen" : (biz._serie_mensual_ingresos ? "ingresos" : "egresos");
        const proyEsc = proyS[proyKey] || null;
        const histVals = (serieHist && Array.isArray(serieHist.valores)) ? serieHist.valores : [];
        if (histVals.length >= 2) {
            const labelsP = serieHist.labels && serieHist.labels.length ? serieHist.labels.slice() : [];
            for (let i = labelsP.length; i < histVals.length; i++) labelsP.push("Período " + (i + 1));
            const n = histVals.length;
            const colorBase = colorColumna(_ejeYActual) || colorSerie("ingresos") || "#7c3aed";
            const datasets = [{
                label: "Histórico",
                data: histVals.map(v => Number(v)),
                borderColor: colorBase,
                backgroundColor: hexARgba(colorBase, 0.15),
                fill: true,
                tension: 0.3,
                pointRadius: 4,
                pointHoverRadius: 6,
                borderWidth: 2,
            }];
            if (proyEsc && proyEsc.proximo !== null && proyEsc.proximo !== undefined) {
                const proxVal = proyKey === "margen" ? proyEsc.proximo : Math.max(0, proyEsc.proximo);
                datasets.push({
                    label: "Proyección",
                    data: [...Array(n - 1).fill(null), Number(histVals[n - 1]), Number(proxVal)],
                    borderColor: "#f59e0b",
                    borderDash: [6, 4],
                    pointRadius: 5,
                    pointBackgroundColor: "#f59e0b",
                    fill: false,
                    tension: 0,
                    borderWidth: 2,
                });
            }
            _crearChartTipo("proyeccionChart", {
                type: "line",
                data: { labels: labelsP.concat(proyEsc && proyEsc.proximo !== null ? ["Próximo"] : []), datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: "top" },
                        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatearMoneda(ctx.raw)}` } },
                    },
                    scales: {
                        y: { beginAtZero: true, ticks: { callback: (v) => `${_monedaActual} ${Number(v).toLocaleString("es-BO")}` } },
                    },
                },
            }, "line");
        } else {
            mostrarPlaceholderGrafico("proyeccionChart", "Gráfica de proyección no disponible: se necesitan al menos 2 períodos con datos.");
        }
    }

    // Meta: objetivo vs real (kpis.meta/porcentaje_meta; input vía fijarMeta()).
    const metaVal = data.kpis && data.kpis.meta;
    if (metaVal !== undefined && metaVal !== null && Number(metaVal) > 0) {
        const metaPct = data.kpis.porcentaje_meta;
        const cumple = Math.min(Math.max(Number(metaPct || 0), 0), 200);
        setTexto("meta-pct", Math.round(cumple) + "%");
        const det = document.getElementById("meta-detalle");
        if (det) det.textContent = `Objetivo ${formatearMoneda(metaVal)} · llevas ${formatearMoneda(data.kpis.suma || 0)}`;
        const inpMeta = document.getElementById("input-meta");
        if (inpMeta) inpMeta.value = metaVal;
    }

    renderizarPuntoEquilibrio(data.business && data.business.punto_equilibrio);
        // [P0B · D-1] Depreciación mensual derivada de la matriz.
        renderizarDepreciacion(data.business && data.business.depreciacion_mensual);
        // [P0B · D-2] Activos Fijos (tabla de equipos, detección genérica).
        renderizarActivosFijos(data.activos_fijos);

    // Tabla de niveles/proyección por serie: SIEMPRE que haya datos.
    const tb = document.getElementById("tbody-proyeccion-series");
    if (tb) {
        const flecha = { creciente: "📈 sube", decreciente: "📉 baja", estable: "➡️ estable" };
        const filas = [
            ["💰 Ingresos", proyS.ingresos, true],
            ["💸 Egresos", proyS.egresos, true],
            ["⚖️ Margen", proyS.margen, false],
        ];
        tb.innerHTML = filas.map(([nom, p, noNegativo]) => {
            if (!p) return `<tr><td>${nom}</td><td colspan="4" class="text-muted">—</td></tr>`;
            const dir = p.direccion
                ? `${flecha[p.direccion] || p.direccion}${p.pendiente !== null && p.pendiente !== undefined ? " (" + formatearMoneda(p.pendiente) + "/período)" : ""}`
                : "—";
            // Ingresos/Egresos no pueden ser negativos: acotar a 0.
            const proxMostrar = (noNegativo && p.proximo !== null && p.proximo !== undefined)
                ? Math.max(0, p.proximo) : p.proximo;
            return `<tr>
                <td>${nom}</td>
                <td class="text-end">${formatearMoneda(p.promedio)}</td>
                <td class="text-end">${formatearMoneda(p.acumulado)}</td>
                <td>${dir}</td>
                <td class="text-end fw-bold">${proxMostrar !== null && proxMostrar !== undefined ? formatearMoneda(proxMostrar) : "—"}</td>
            </tr>`;
        }).join("");
    }
    // [Fase 8 · T8.2] Montar/actualizar botones de detalle colapsable
    _montarColapsables();
    });
}

// [Fase O-3 §2.4] Módulos del dashboard y sus contenedores. Claves de
// visibilidad leídas de `config.graficos_visibles` (canónico ÚNICO).
const _MODULOS_DASHBOARD = [
    { clave: "trend_visible",     etiqueta: "Tendencia",    ids: ["wrap-graph-trend"],                          tabs: ["tab-resumen"] },
    // [R-7] Distribución (hist/ojiva/box/pareto) → tab Datos (ya no tab-analisis)
    { clave: "desglose_visible",  etiqueta: "Desglose",     ids: ["wrap-graph-histogram", "wrap-graph-ojiva", "wrap-graph-boxplot", "wrap-graph-pareto"], tabs: ["tab-datos"] },
    // [R-7] Estadísticas → tab Datos (bug latente corregido: antes "tab-stats" no existía)
    { clave: "stats_visible",     etiqueta: "Estadísticas", ids: ["wrap-graph-stats"],                             tabs: ["tab-datos"] },
    // [R-7] Rankings + Anomalías + Cuartiles + Registros → tab Datos
    { clave: "rankings_visible",  etiqueta: "Rankings",     ids: ["wrap-tabla-pareto"],                          tabs: ["tab-datos"] },
    { clave: "anomalies_visible", etiqueta: "Anomalías",    ids: ["wrap-graph-anomalies"],                      tabs: ["tab-datos"] },
    { clave: "cuartiles_visible", etiqueta: "Cuartiles",     ids: ["wrap-graph-cuartiles"],                       tabs: ["tab-datos"] },
    { clave: "registros_visible", etiqueta: "Registros",    ids: ["wrap-grid-registros"],                       tabs: ["tab-datos"] },
    // [Plan F · E2] Widgets financieros (Frente C) bajo el mismo canónico.
    { clave: "fin_grid_visible",          etiqueta: "Tarjetas Finanzas",  ids: ["z-fin-grid", "adv-fin-grid"],           tabs: ["tab-resumen"] },
    { clave: "dos_col_visible",           etiqueta: "Resúmenes I/E",  ids: ["adv-dos-col"], tabs: ["tab-analisis"] },
    { clave: "desglose_concepto_visible", etiqueta: "Desglose Concepto",  ids: ["wrap-desglose-concepto"],               tabs: ["tab-analisis"] },
    { clave: "margen_entidad_visible",    etiqueta: "Margen Entidad",     ids: ["wrap-margen-entidad"],                  tabs: ["tab-analisis"] },
    // [PRIORIDAD 0 · LISTA DUEÑO §2] Margen por Procedimiento (derivado de la matriz).
    { clave: "margen_procedimiento_visible", etiqueta: "Margen Procedimiento", ids: ["wrap-margen-procedimiento"],       tabs: ["tab-analisis"] },
    // [P0B · D-3] Margen por Paciente (cuadro completo por operación).
    { clave: "margen_paciente_visible", etiqueta: "Margen Paciente", ids: ["wrap-margen-paciente"],                tabs: ["tab-analisis"] },
    // [P0B · D-1] Depreciación mensual (derivada de la matriz).
    { clave: "depreciacion_visible", etiqueta: "Depreciación", ids: ["wrap-depreciacion"],                     tabs: ["tab-analisis"] },
    // [P0B · D-2] Activos Fijos (tabla de equipos, detección genérica).
    { clave: "activos_fijos_visible", etiqueta: "Activos Fijos", ids: ["wrap-activos-fijos"],                  tabs: ["tab-analisis"] },
    // [P-7 · P-8 · 31/08] Waterfall de margen + Costos fijos vs variables.
    { clave: "waterfall_margen_visible", etiqueta: "Waterfall margen",     ids: ["wrap-waterfall-margen"],      tabs: ["tab-analisis"] },
    { clave: "stacked_costos_visible",   etiqueta: "Costos fijos vs var.", ids: ["wrap-stacked-costos"],       tabs: ["tab-analisis"] },
    // [P-9] Flujo de caja acumulado.
    { clave: "flujo_caja_visible",       etiqueta: "Flujo de caja",        ids: ["wrap-flujo-caja"],            tabs: ["tab-analisis"] },
    // [P-10 · 09/09] Heatmap de estacionalidad (mes × métrica).
    { clave: "heatmap_visible",          etiqueta: "Estacionalidad",       ids: ["wrap-heatmap"],               tabs: ["tab-analisis"] },
    // [P-12b · 09/09] Ingresos vs Egresos por categoría (barras agrupadas).
    { clave: "ie_categoria_visible",     etiqueta: "I vs E por categoría", ids: ["wrap-ie-categoria"],          tabs: ["tab-analisis"] },
    // [P-11] Insights extendidos (frases automáticas).
    { clave: "insights_ext_visible",     etiqueta: "Insights automáticos", ids: ["insights-extendidos"],        tabs: ["tab-insights"] },
    // [PRIORIDAD 0 · LISTA DUEÑO §5] Resumen mensual derivado de la matriz.
    { clave: "resumen_mensual_visible",   etiqueta: "Resumen mensual",    ids: ["wrap-resumen-mensual"],                 tabs: ["tab-analisis"] },
    // [Fase 5] Más módulos apagables: narrativa, explorador por dimensión,
    // ficha y aviso de plantilla (para dejar el dashboard "solo tendencia").
    { clave: "narrative_visible",   etiqueta: "Resumen ejecutivo", ids: ["wrap-narrative"],          tabs: ["tab-resumen"] },
    // [T-1 · 31/08] Resumen BI: semáforo de meta + Top 5 por margen.
    { clave: "semaforo_meta_visible", etiqueta: "Semáforo de meta", ids: ["wrap-semaforo-meta"], tabs: ["tab-resumen"] },
    { clave: "top5_visible",          etiqueta: "Top 5 por margen", ids: ["wrap-top5"],          tabs: ["tab-resumen"] },
    // [P-5] Donut Cirugías vs Consultas
    { clave: "donut_consultas_visible", etiqueta: "Donut Cir vs Cons", ids: ["wrap-donut-consultas"], tabs: ["tab-resumen"] },
    // [T-1 · 31/08] Fila de volumen (Consultas · Cirugías) — fila pequeña.
    { clave: "fin_vol_visible",       etiqueta: "Volumen (Consultas/Cirugías)", ids: ["z-fin-grid-vol"], tabs: ["tab-resumen"] },
    { clave: "dims_visible",        etiqueta: "Por Dimensión",     ids: ["wrap-dims-financieras"],   tabs: ["tab-resumen"] },
    // [R-7] Ficha de contexto → tab Datos
    { clave: "ficha_visible",       etiqueta: "Ficha de contexto", ids: ["ficha-contexto"],          tabs: ["tab-datos"] },
    // [P-13 · 09/09] Panel de calidad de datos → tab Datos
    { clave: "calidad_visible",     etiqueta: "Calidad de datos",  ids: ["wrap-calidad-datos"],      tabs: ["tab-datos"] },
    // [P-14 · 09/09] Estadística de negocio → tab Datos
    { clave: "stats_negocio_visible", etiqueta: "Estadística negocio", ids: ["wrap-stats-negocio"],  tabs: ["tab-datos"] },
    { clave: "aviso_plantilla_visible", etiqueta: "Aviso / plantilla", ids: ["aviso-plantilla"],     tabs: ["tab-resumen"] },
];

function aplicarVisibilidadGuardada(config) {
    config = config || {};
    const gv = config.graficos_visibles || {};
    // Canónico único: graficos_visibles[clave]; fallback a la clave suelta
    // legacy config[clave] para configs guardadas antes de O-3.
    _MODULOS_DASHBOARD.forEach(mod => {
        const valor = gv[mod.clave] !== undefined ? gv[mod.clave] : config[mod.clave];
        if (valor === false) {
            mod.ids.forEach(id => {
                const n = document.getElementById(id);
                if (n) n.classList.add("d-none");
            });
        }
    });
    // Legado: tarjetas KPI sueltas (configs anteriores a O-3)
    const mapa = {
        total_visible: "kpi-card-total", promedio_visible: "kpi-card-promedio",
        crecimiento_visible: "kpi-card-crecimiento", proyeccion_visible: "kpi-card-proyeccion",
        meta_visible: "kpi-card-meta", histogram_visible: "wrap-graph-histogram",
        ojiva_visible: "wrap-graph-ojiva", boxplot_visible: "wrap-graph-boxplot",
        pareto_visible: "wrap-graph-pareto", anomalies_visible: "wrap-graph-anomalies",
    };
    Object.entries(mapa).forEach(([clave, elementId]) => {
        if (config[clave] === false) {
            const node = document.getElementById(elementId);
            if (node) node.classList.add("d-none");
        }
    });
    // [Auditoría O] Listas legacy de toggleElemento (§17.2): el botón "👁" de
    // cada tarjeta persiste en tarjetas_ocultas/graficos_ocultos. Se aplican al
    // cargar para que su estado sobreviva a la recarga (antes se perdía).
    const ocultasListas = [].concat(config.tarjetas_ocultas || [], config.graficos_ocultos || []);
    ocultasListas.forEach(id => {
        const n = document.getElementById(id);
        if (n) n.classList.add("d-none");
    });
}

// [Fase O-3] Barra de módulos: estado de cada toggle desde el config guardado.
function renderizarBarraModulos(config) {
    _configActual = config || {};
    renderizarBarraModulosPorTab(_tabActivoActual || "tab-resumen");
}

// [Fase 3] Los toggles viven DENTRO del panel único de personalización
// (contenedor fijo, ya sin barra flotante que se reubique entre tabs).
// Muestra solo los módulos del tab activo.
function renderizarBarraModulosPorTab(tabId) {
    const panel = document.getElementById(tabId);
    const cont = document.getElementById("contenedor-toggles-modulos");
    if (!panel || !cont) return;
    const gv = (_configActual && _configActual.graficos_visibles) || {};
    const mods = _MODULOS_DASHBOARD.filter(m => (m.tabs || []).includes(tabId));
    if (!mods.length) {
        cont.innerHTML = '<span class="text-muted small">Esta vista no tiene módulos apagables.</span>';
        return;
    }
    cont.innerHTML = mods.map(mod => {
        const valor = gv[mod.clave] !== undefined ? gv[mod.clave] : (_configActual && _configActual[mod.clave] !== undefined ? _configActual[mod.clave] : true);
        const checked = valor !== false;
        return `<label class="d-flex align-items-center gap-1 border rounded px-2 py-1 small mb-0"
                        style="cursor:pointer;background:${checked ? "#f8fafc" : "#f1f5f9"}">
                    <input type="checkbox" data-modulo="${mod.clave}" ${checked ? "checked" : ""}
                           onchange="toggleModuloVisibilidad('${mod.clave}')">
                    ${mod.etiqueta}
                </label>`;
    }).join("");
}

// [Fase O-3] Ocultar/mostrar un módulo Y persistirlo en config.graficos_visibles
// (canónico único, dict COMPLETO vía fusión superficial de config_utils).
async function toggleModuloVisibilidad(clave) {
    if (!currentTablaId) return;
    const mod = _MODULOS_DASHBOARD.find(m => m.clave === clave);
    if (!mod) return;
    const cb = document.querySelector(`#contenedor-toggles-modulos input[data-modulo="${clave}"]`);
    const visible = cb ? cb.checked : true;
    mod.ids.forEach(id => {
        const n = document.getElementById(id);
        if (n) n.classList.toggle("d-none", !visible);
    });
    try {
        const cfg = await cargarConfigBloque(currentTablaId);
        const gv = Object.assign({}, cfg.graficos_visibles || {});
        gv[clave] = visible;
        await fetch(`/api/bloque/${currentTablaId}/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ graficos_visibles: gv }),
        });
        // Sincronizar dependencias (visibilidad legada también se quita)
        aplicarVisibilidadGuardada(Object.assign({}, cfg, { graficos_visibles: gv }));
    } catch (_) { /* no bloquear UI si falla persistencia */ }
}

// [Fase O-3 §2.6] Control de meta del período → recalcula kpis.porcentaje_meta.
function fijarMeta() {
    const raw = document.getElementById("input-meta").value;
    if (!raw || isNaN(Number(raw))) return;
    _metaActual = Number(raw);
    if (currentTablaId) cargarDashboard(currentTablaId);
}

// --- Graficos ---
function _destruirChart(canvasId) {
    if (_charts[canvasId]) { _charts[canvasId].destroy(); delete _charts[canvasId]; }
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    canvas.classList.remove("d-none");
    const aviso = canvas.parentElement.querySelector(".aviso-pendiente");
    if (aviso) aviso.remove();
}

// [Plan F-2 — Fase 1] Genera bins + frecuencias para histograma/ojiva a
// partir de la serie numérica real (data.serie_grafico). NO duplica
// fg-data-profiling: es un gráfico de apoyo del dashboard; el reporte
// profundo de la librería sigue viviendo en el tab EDA.
function crearBins(valores, numBins) {
    if (!Array.isArray(valores) || valores.length < 2) return { bins: [], frecuencias: [] };
    const n = Math.max(4, Math.min(parseInt(numBins, 10) || 8, 20));
    const min = Math.min(...valores);
    const max = Math.max(...valores);
    const rango = max - min;
    if (rango === 0) return { bins: [min, max + 1], frecuencias: [valores.length] };
    const ancho = rango / n;
    const bins = [];
    const acumFrec = new Array(n).fill(0);
    for (let i = 0; i <= n; i++) bins.push(min + i * ancho);
    valores.forEach(v => {
        let idx = Math.floor((v - min) / ancho);
        if (idx >= n) idx = n - 1;
        if (idx >= 0) acumFrec[idx]++;
    });
    return { bins, frecuencias: acumFrec };
}

// [Plan F-2 — Fase 1] El config real NO viaja en /api/dashboard/<id>.
// Se obtiene de /api/tabla/<id> (panel_api.obtener_tabla devuelve config
// del CoreBloque) para poder aplicar visibilidad guardada y alertas.
async function cargarConfigBloque(bloqueId) {
    try {
        const res = await fetch(`/api/tabla/${bloqueId}`);
        if (!res.ok) return {};
        const data = await res.json();
        const cfg = data.config;
        if (typeof cfg === "string") { try { return JSON.parse(cfg); } catch (_) { return {}; } }
        return cfg || {};
    } catch (_) {
        return {};
    }
}

// [Plan G v1.0.0] Tarjetas de ranking rediseñadas: pestañas (Top/Bottom/Cero)
// en una sola card, filas numeradas con color de categoría (R22) y barra de proporción.
function renderizarRankingsFinancieros(rankings) {
    if (!rankings) return;
    const top = rankings.top || [];
    const bottom = rankings.bottom || [];
    const cero = rankings.cero || [];
    if (!top.length && !bottom.length && !cero.length) return;

    const zona = document.getElementById("wrap-tabla-pareto");
    if (!zona) return;

    // Contenedor único, se reusa entre recargas
    let cont = document.getElementById("contenedor-ranking-f2");
    if (!cont) {
        cont = document.createElement("div");
        cont.id = "contenedor-ranking-f2";
        cont.className = "card border-0 shadow-sm p-3 mt-3";
        zona.appendChild(cont);
    }

    const maxTop = top.length ? top[0].valor : 1;
    const maxBot = bottom.length ? Math.abs(bottom[0].valor) : 1;

    function _fila(item, i, maxVal) {
        const colorCat = _coloresCategoriaActual[item.etiqueta] || PALETA_DEFAULT[i % PALETA_DEFAULT.length];
        const ancho = maxVal > 0 ? Math.min((Math.abs(item.valor) / maxVal) * 100, 100) : 0;
        return `<div class="d-flex align-items-center gap-2 py-1 border-bottom small">
            <span class="text-muted fw-bold" style="width:18px">#${i + 1}</span>
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${colorCat};flex-shrink:0"></span>
            <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.etiqueta}</span>
            <span class="fw-bold text-end" style="min-width:90px">${formatearMoneda(item.valor)}</span>
            <span style="width:60px;height:6px;background:#f1f5f9;border-radius:3px;flex-shrink:0">
                <span style="display:block;height:100%;width:${ancho}%;background:${colorCat};border-radius:3px"></span>
            </span>
        </div>`;
    }

    // Pestañas
    const tabActive = top.length ? 'top' : (bottom.length ? 'bottom' : 'cero');
    const tabs = [];
    if (top.length) tabs.push({id:'top',label:'🏆 Top 5',cls:'text-success'});
    if (bottom.length) tabs.push({id:'bottom',label:'⬇ Bottom 5',cls:'text-danger'});
    if (cero.length) tabs.push({id:'cero',label:'0️⃣ En cero',cls:'text-warning'});

    cont.innerHTML = `
        <h6 class="fw-bold mb-2">🏆 Ranking financiero (Top / Bottom / Cero)</h6>
        <div class="d-flex gap-1 mb-2" id="ranking-tabs">
            ${tabs.map(t => `<button class="btn btn-sm ${t.id === tabActive ? 'btn-primary' : 'btn-outline-secondary'}"
                onclick="switchRankingTab('${t.id}')" id="ranking-tab-${t.id}">${t.label}</button>`).join('')}
        </div>
        <div id="ranking-content-top" style="display:${tabActive === 'top' ? '' : 'none'}">
            ${top.map((x,i) => _fila(x,i,maxTop)).join('') || '<p class="text-muted small">Sin datos.</p>'}
        </div>
        <div id="ranking-content-bottom" style="display:${tabActive === 'bottom' ? '' : 'none'}">
            ${bottom.map((x,i) => _fila(x,i,maxBot)).join('') || '<p class="text-muted small">Sin datos.</p>'}
        </div>
        <div id="ranking-content-cero" style="display:${tabActive === 'cero' ? '' : 'none'}">
            ${cero.map((x,i) => `<div class="d-flex align-items-center gap-2 py-1 small"><span class="text-muted" style="width:18px">○</span><span>${x.etiqueta}</span></div>`).join('') || '<p class="text-muted small">Sin datos.</p>'}
        </div>`;
}

// [Plan G] Cambio de pestaña de rankings
function switchRankingTab(tabId) {
    ['top','bottom','cero'].forEach(id => {
        const btn = document.getElementById(`ranking-tab-${id}`);
        const content = document.getElementById(`ranking-content-${id}`);
        if (btn) btn.className = `btn btn-sm ${id === tabId ? 'btn-primary' : 'btn-outline-secondary'}`;
        if (content) content.style.display = id === tabId ? '' : 'none';
    });
}

// [Plan F-2 §20] Alerta de proximidad de fecha (tarjeta no bloqueante).
function mostrarAlertaProximidad(conteo) {
    const el = document.getElementById("alerta-proximidad-f2");
    if (!el) return;
    el.classList.remove("d-none");
    el.querySelector("#alerta-proximidad-texto").textContent =
        `${conteo} elemento(s) vencen en los próximos 7 días.`;
}

// [Fase B-UI] Ratio genérico: consume /api/dashboard/<id>/ratio
// con col_a, col_b, operacion elegidas por el usuario. Muestra el resultado.
async function calcularRatio() {
    if (!currentTablaId) return;
    const colA = document.getElementById("ratio-col-a").value;
    const colB = document.getElementById("ratio-col-b").value;
    const op = document.getElementById("ratio-operacion").value;
    const res = document.getElementById("ratio-resultado");
    if (!colA || !colB) { res.textContent = "Selecciona Col A y Col B."; return; }
    try {
        const r = await fetch(`/api/dashboard/${currentTablaId}/ratio?col_a=${encodeURIComponent(colA)}&col_b=${encodeURIComponent(colB)}&operacion=${op}`).then(x => x.json());
        res.textContent = r.valor !== null && r.valor !== undefined ? `= ${formatearNum(r.valor)} (n=${r.n})` : "Sin datos";
    } catch (e) { res.textContent = "Error al calcular."; }
}

// [Plan F-2 §17] Mostrar/ocultar tarjetas y gráficos individuales.
// Persiste en CoreBloque.config (tarjetas_ocultas/graficos_ocultos) vía
// PATCH /api/bloque/<id>/config (ya soportado por backend Plan F-2 T9).
async function toggleElemento(elementId, tipo) {
    const el = document.getElementById(elementId);
    if (!el || !currentTablaId) return;
    const ocultar = !el.classList.contains("d-none");
    el.classList.toggle("d-none", ocultar);
    try {
        const cfg = await cargarConfigBloque(currentTablaId);
        const clave = tipo === "ver" ? "tarjetas_ocultas" : (tipo === "graf" ? "graficos_ocultos" : "tarjetas_ocultas");
        const lista = new Set(cfg[clave] || []);
        if (ocultar) lista.add(elementId); else lista.delete(elementId);
        await fetch(`/api/bloque/${currentTablaId}/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [clave]: [...lista] }),
        });
    } catch (_) { /* no bloquear UI si falla persistencia */ }
}

function mostrarPlaceholderGrafico(canvasId, mensaje) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (_charts[canvasId]) { _charts[canvasId].destroy(); delete _charts[canvasId]; }
    canvas.classList.add("d-none");
    const parent = canvas.parentElement;
    let aviso = parent.querySelector(".aviso-pendiente");
    if (!aviso) {
        aviso = document.createElement("div");
        aviso.className = "aviso-pendiente text-muted small text-center p-3";
        parent.appendChild(aviso);
    }
    aviso.textContent = mensaje;
}

function dibujarGraficoTrend(labels, valores) {
    _destruirChart("mainTrendChart");
    // [Plan F] Color VINCULADO: columna Y analizada -> tendencia -> paleta.
    const colorTrend = colorColumna(_ejeYActual)
        || colorSerie("ingresos")
        || "#7c3aed";
    _charts.mainTrendChart = new Chart(document.getElementById("mainTrendChart"), {
        type: "line",
        data: { labels, datasets: [{ label: "Volumen mensual", data: valores,
            borderColor: colorTrend, backgroundColor: hexARgba(colorTrend, 0.15),
            borderWidth: 2, fill: true, tension: 0.3,
            pointRadius: 3, pointHoverRadius: 6 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${formatearMoneda(ctx.raw)}`,
                    },
                },
                legend: { display: true, labels: { color: "#334155" } },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { callback: (v) => `${_monedaActual} ${Number(v).toLocaleString("es-BO")}` },
                },
            },
        },
    });
}

function dibujarParetoChart(categorias, valores) {
    const canvas = document.getElementById("paretoChart");
    if (!canvas) return;
    const total = valores.reduce((a, b) => a + b, 0);
    let acc = 0;
    const acumulado = valores.map(v => { acc += v; return total !== 0 ? (acc / total) * 100 : 0; });
    // [Plan C v1.0.0] Color por categoría uniforme (mismos colores que dona/chips/PDF).
    const coloresCategoria = obtenerPaletaColores(categorias);

    _crearChartTipo("paretoChart", {
        type: "bar",
        data: {
            labels: categorias,
            datasets: [
                { label: "Monto", data: valores, backgroundColor: coloresCategoria, yAxisID: "y", borderRadius: 6 },
                { label: "% Acumulado", data: acumulado, type: "line", borderColor: "#7c3aed", yAxisID: "y1", borderWidth: 2, pointRadius: 2 },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                tooltip: {
                    callbacks: {
                        label: (ctx) => ctx.dataset.label === "Monto"
                            ? `Monto: ${formatearMoneda(ctx.raw)}`
                            : `% Acumulado: ${formatearNum(ctx.raw, 1)}%`,
                    },
                },
            },
            scales: { y: { position: "left" }, y1: { position: "right", min: 0, max: 100, grid: { drawOnChartArea: false } } },
        },
    }, "bar");
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw("paretoChart", () => dibujarParetoChart(categorias, valores));
    }
}

function dibujarHistograma(bins, frecuencias) {
    const canvas = document.getElementById("histogramChart");
    if (!canvas) return;
    const labels = frecuencias.map((_, i) => `${formatearNum(bins[i], 0)}-${formatearNum(bins[i + 1], 0)}`);
    _crearChartTipo("histogramChart", {
        type: "bar",
        data: { labels, datasets: [{ label: "Frecuencia", data: frecuencias,
            backgroundColor: colorColumna(_ejeYActual) || PALETA.secundario, barPercentage: 1, categoryPercentage: 1, borderRadius: 4 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: { label: (ctx) => `Frecuencia: ${formatearNum(ctx.raw, 0)} registros` },
                },
            },
        },
    }, "bar");
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw("histogramChart", () => dibujarHistograma(bins, frecuencias));
    }
}

function dibujarOjiva(bins, frecuencias) {
    const canvas = document.getElementById("ojivaChart");
    if (!canvas) return;
    let acc = 0;
    const total = frecuencias.reduce((a, b) => a + b, 0);
    const acumulado = frecuencias.map(f => { acc += f; return total !== 0 ? (acc / total) * 100 : 0; });
    const labels = bins.slice(1).map(b => formatearNum(b, 0));
    _crearChartTipo("ojivaChart", {
        type: "line",
        data: { labels, datasets: [{ label: "% Acumulado", data: acumulado,
            borderColor: colorColumna(_ejeYActual) || "#7c3aed", fill: false, tension: 0.3, borderWidth: 2 }] },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { min: 0, max: 100 } },
                   plugins: { legend: { display: false },
                              tooltip: { callbacks: { label: (ctx) => `% Acumulado: ${formatearNum(ctx.raw, 1)}%` } } } },
    }, "line");
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw("ojivaChart", () => dibujarOjiva(bins, frecuencias));
    }
}

function dibujarBoxPlot(min, q1, mediana, q3, max) {
    const container = document.getElementById("box-plot-svg-container");
    if (!container) return;
    if ([min, q1, mediana, q3, max].some(v => v === undefined || v === null)) {
        container.innerHTML = '<p class="text-muted small text-center p-3 mb-0">Datos insuficientes para el diagrama de caja.</p>';
        return;
    }
    const rango = (max - min) === 0 ? 1 : (max - min);
    const pct = v => ((v - min) / rango) * 80 + 10;
    container.innerHTML = `
        <svg width="100%" height="80" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;">
            <line x1="${pct(min)}%" y1="40" x2="${pct(q1)}%" y2="40" stroke="#475569" stroke-width="2"/>
            <line x1="${pct(q3)}%" y1="40" x2="${pct(max)}%" y2="40" stroke="#475569" stroke-width="2"/>
            <line x1="${pct(min)}%" y1="25" x2="${pct(min)}%" y2="55" stroke="#475569" stroke-width="2"/>
            <line x1="${pct(max)}%" y1="25" x2="${pct(max)}%" y2="55" stroke="#475569" stroke-width="2"/>
            <rect x="${pct(q1)}%" y="20" width="${pct(q3) - pct(q1)}%" height="40" fill="${hexARgba(colorColumna(_ejeYActual) || colorSerie("ingresos"), 0.30)}" stroke="#334155" stroke-width="2"/>
            <line x1="${pct(mediana)}%" y1="20" x2="${pct(mediana)}%" y2="60" stroke="${colorSerie("egresos")}" stroke-width="3"/>
        </svg>
        <div class="d-flex justify-content-between text-muted px-2 mt-1" style="font-size:0.75rem;">
            <span>Min: ${formatearNum(min, 0)}</span>
            <span>Q1: ${formatearNum(q1, 0)}</span>
            <span>Mediana: ${formatearNum(mediana, 0)}</span>
            <span>Q3: ${formatearNum(q3, 0)}</span>
            <span>Max: ${formatearNum(max, 0)}</span>
        </div>`;
}

function inicializarAgGridAnomalies(rowData) {
    const div = document.getElementById("grid-anomalias-ml");
    if (_gridAnomalias) { try { _gridAnomalias.destroy(); } catch (e) {} _gridAnomalias = null; }
    div.innerHTML = "";
    // [Plan N-2] encabezado explicativo de la columna sobre la que se evalúan
    const sub = document.getElementById("anomalias-subtitulo");
    if (sub) {
        sub.textContent = _ejeYActual ? `Sobre la columna «${_ejeYActual}»` : "";
    }
    if (!rowData || !rowData.length) {
        div.innerHTML = '<p class="text-muted small text-center p-3 mb-0">No se detectaron valores que resalten de lo normal en este dataset.</p>';
        return;
    }
    const gridOptions = {
        columnDefs: [
            { field: "indice", headerName: "Fila #", width: 90, sortable: true, filter: true },
            { field: "valor", headerName: "Valor", sortable: true, filter: true,
              valueFormatter: p => formatearMoneda(p.value) },
            { field: "tipo", headerName: "Resalta por…", width: 220, sortable: true,
              valueFormatter: p => p.value === "alto"
                  ? "Valor más alto de lo normal"
                  : "Valor más bajo de lo normal" },
        ],
        rowData,
        pagination: true,
        paginationPageSize: 5,
        // [Plan N-2b] doble clic en una anomalía → mostrar esa fila en Registros
        onRowDoubleClicked: params => {
            const idx = params.data && params.data.indice;
            if (idx !== undefined && idx !== null) drillDownAnomalia(idx);
        },
    };
    // [fix] AG Grid Community 30.x usa `new agGrid.Grid(el, opts)`,
    // no `createGrid` (API de v31+). El vendor instalado es 30.x.
    _gridAnomalias = new agGrid.Grid(div, gridOptions);
}

// [Plan N-2b] Drill-down de anomalías: el `indice` de la anomalía es la
// posición posicional (0..N-1) en el DataFrame del bloque, que coincide con
// la posición de `_registrosOriginales` (mismo Parquet, mismo orden). Al hacer
// clic en una anomalía se muestra SOLO esa fila en el grid de registros,
// evitando cualquier comparación de flotantes (bug conocido de "valor exacto").
function drillDownAnomalia(filaIndice) {
    if (!_gridApiRegistros || !_registrosOriginales) return;
    if (filaIndice === undefined || filaIndice === null) return;
    const n = _registrosOriginales.length;
    const avisoTrunc = document.getElementById("aviso-grid-truncado");
    if (filaIndice < 0 || filaIndice >= n) {
        if (avisoTrunc) {
            avisoTrunc.innerHTML = `La fila #${filaIndice} está fuera del rango cargado (se muestran ${n} filas).`;
            avisoTrunc.classList.remove("d-none");
        }
        return;
    }
    // [fix] AG Grid v30.2.1: usar la API capturada (setRowData), no setGridOption
    _gridApiRegistros.setRowData([_registrosOriginales[filaIndice]]);
    const chip = document.getElementById("banner-filtro-anomalia");
    if (chip) {
        chip.classList.remove("d-none");
        const txt = document.getElementById("banner-anomalia-texto");
        if (txt) txt.textContent = `Mostrando la fila #${filaIndice} (anomalía). `;
    }
    const wrap = document.getElementById("wrap-grid-registros");
    if (wrap) wrap.scrollIntoView({ behavior: "smooth", block: "center" });
}

function limpiarFiltroAnomalia() {
    if (_gridApiRegistros) _gridApiRegistros.setRowData(_registrosOriginales);
    const chip = document.getElementById("banner-filtro-anomalia");
    if (chip) chip.classList.add("d-none");
}

// --- Toggle de visibilidad persistente ---
// --- Reconstruccion de Parquet (R11) ---
async function ejecutarReconstruccionParquet() {
    const input = document.getElementById("reconstruct-file-input");
    const errBox = document.getElementById("reconstruct-error");
    errBox.classList.add("d-none");
    if (!input.files.length) return;

    const fd = new FormData();
    fd.append("archivo", input.files[0]);

    try {
        const res = await fetch(`/api/tabla/${currentTablaId}/reconstruct-native`, { method: "POST", body: fd });
        const data = await res.json();
        if (res.ok) {
            cerrarModal("modalReconstructNative");
            ocultarBanner();
            cargarDashboard(currentTablaId);
        } else {
            errBox.textContent = data.error || MENSAJES_ERROR.DEFAULT;
            errBox.classList.remove("d-none");
        }
    } catch (e) {
        errBox.textContent = MENSAJES_ERROR.DEFAULT;
        errBox.classList.remove("d-none");
    }
}

// --- Eliminar dataset ---
// [Fix] El usuario quiere eliminar el EXCEL COMPLETO (importación), no solo un
// bloque. Resolvemos el importacion_id del bloque actual y llamamos a
// DELETE /api/importaciones/<importacion_id> (nuevo endpoint que borra la
// importación completa + parquets en cascada).
async function confirmarEliminarDataset() {
    if (!currentTablaId) return;
    if (!confirm("Esta operacion eliminara permanentemente este dataset y su archivo de datos. Deseas continuar?")) return;
    try {
        const importacionId = await obtenerImportacionIdDeBloque(currentTablaId);
        if (!importacionId) { alert(MENSAJES_ERROR.DEFAULT); return; }
        const res = await fetch(`/api/importaciones/${importacionId}`, { method: "DELETE" });
        const d = await res.json().catch(() => ({}));
        alert(d.message || d.error || "Operacion completada.");
        window.location.href = "/import";
    } catch (e) {
        alert(MENSAJES_ERROR.DEFAULT);
    }
}

// [Fix] Resuelve el importacion_id al que pertenece un bloque (CoreBloque.id).
// El endpoint /api/export/pdf/<importacion_id> espera el id de la IMPORTACIÓN,
// no el del bloque — por eso daba 404 (ej. /api/export/pdf/87).
async function obtenerImportacionIdDeBloque(bloqueId) {
    try {
        const res = await fetch("/api/importaciones");
        if (!res.ok) return null;
        const importaciones = await res.json();
        for (const imp of importaciones) {
            const hojas = imp.hojas || [];
            if (hojas.some(h => h.bloque_id === Number(bloqueId) || h.id === Number(bloqueId))) {
                return imp.id;
            }
        }
        return null;
    } catch (_) {
        return null;
    }
}

// --- Exportar PDF ---
// [Plan H-1 v4.0.0] Flujo asíncrono: POST dispara job (202 + job_id) →
// polling a status → descarga. Si status falla, cae al endpoint síncrono /sync.
// --- Configuracion de mapeo post-importacion (R5, R6, R19) ---

let _columnasDisponibles = [];

async function abrirModalMapeo() {
    if (!currentTablaId) {
        console.warn("abrirModalMapeo: currentTablaId no definido");
        return;
    }

    const errBox = document.getElementById("mapeo-error");
    if (errBox) errBox.classList.add("d-none");

    try {
        const res = await fetch(`/api/tabla/${currentTablaId}/columnas`);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            console.error("Error cargando columnas:", data.error);
            return;
        }
        const data = await res.json();
        _columnasDisponibles = data.columnas || [];

        // Poblar resumen de columnas disponibles
        const resumen = document.getElementById("mapeo-columnas-resumen");
        if (resumen) {
            const badges = _columnasDisponibles.map(c => {
                const icono = c.tipo_detectado === "numerico" ? "&#x1F522;"
                    : c.tipo_detectado.includes("fecha") ? "&#x1F4C5;" : "&#x1F524;";
                return `<span class="badge bg-secondary me-1">${icono} ${c.nombre}</span>`;
            }).join("");
            resumen.innerHTML = `
                <strong>${_columnasDisponibles.length} columnas disponibles:</strong>
                <div class="mt-1">${badges}</div>
            `;
        }

        // Poblar los cuatro selectores del modal
        const SELECTORES = [
            { id: "mapeo-sel-monto",     campo: "es_col_monto"     },
            { id: "mapeo-sel-fecha",     campo: "es_col_fecha"      },
            { id: "mapeo-sel-categoria", campo: "es_col_categoria"  },
            { id: "mapeo-sel-tipo",      campo: "es_col_tipo"       },
        ];

        SELECTORES.forEach(({ id, campo }) => {
            const sel = document.getElementById(id);
            if (!sel) return;
            sel.innerHTML = '<option value="">— No aplica —</option>';

            _columnasDisponibles.forEach(col => {
                const icono = col.tipo_detectado === "numerico" ? " &#x1F522;"
                    : col.tipo_detectado.includes("fecha") ? " &#x1F4C5;" : " &#x1F524;";
                const vista = col.muestra.length > 0
                    ? `  \u2192  ${col.muestra.slice(0, 2).join(" | ")}`
                    : "";
                const opt = document.createElement("option");
                opt.value = col.nombre;
                opt.textContent = `${col.nombre}${icono}${vista}`;
                if (col[campo]) opt.selected = true;
                sel.appendChild(opt);
            });
        });

        // Abrir modal usando sistema propio (abrirModal de base.html)
        if (typeof abrirModal === "function") {
            abrirModal("modalMapeoColumnas");
        } else {
            console.warn("abrirModal no definida. Verificar base.html.");
        }

    } catch (e) {
        console.error("Error en abrirModalMapeo:", e);
    }
}

// ─── Paleta de colores por categoría (E15 — Sesión 2.1) ─────────────────────
const PALETA_DEFAULT = [
    "#7c3aed","#10b981","#ef4444","#f59e0b","#3b82f6",
    "#ec4899","#8b5cf6","#14b8a6","#f97316","#6366f1",
];

let _coloresCategoriaActual = {};

// [Fase dedup · FIX] Color por defecto ESTABLE por nombre: cada columna/
// categoría nace con un color DISTINTO (hash del nombre → paleta), y se
// mantiene igual entre recargas aunque el usuario no lo haya personalizado.
function _colorDefectoEstable(nombre) {
    const s = String(nombre || "");
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETA_DEFAULT[h % PALETA_DEFAULT.length];
}



// [Fase V · E4 + E2/E3] Punto de Equilibrio: métricas + estructura de gastos
// (clasificación ÚNICA del backend: estructura_gastos) + gráfica Ingresos vs
// Costos con cruce en el PE. El frontend SOLO pinta — nunca re-clasifica.
function renderizarPuntoEquilibrio(pe) {
    if (!pe || typeof pe !== "object") return;
    const setVal = (id, txt) => {
        const el = document.getElementById(id);
        if (el) el.textContent = txt;
    };
    setVal("pe-ingresos", formatearMoneda(pe.ingresos_brutos));
    setVal("pe-fijos", formatearMoneda(pe.gastos_fijos));
    setVal("pe-variables", formatearMoneda(pe.gastos_variables));
    setVal("pe-operativo", formatearMoneda(pe.resultado_operativo));
    // [FIX] Las porciones son % — NO pasar por formatearMoneda (Number("18.5%")
    // = NaN mostraba "$ NaN"). formatearPct es el formateador correcto.
    setVal("pe-porcion-fija", pe.porcion_fija_pct != null ? formatearPct(pe.porcion_fija_pct) : "—");
    setVal("pe-porcion-var", pe.porcion_variable_pct != null ? formatearPct(pe.porcion_variable_pct) : "—");
    setVal("pe-unidades", pe.pe_unidades != null ? formatearNum(pe.pe_unidades, 1) : "—");
    setVal("pe-ventas", pe.pe_ventas != null ? formatearMoneda(pe.pe_ventas) : "—");
    // [E3 · LISTA DUEÑO] Unidad económica: unidades, precio promedio, CVU y
    // margen unitario (el backend ya los calcula — sin duplicar cálculo).
    setVal("pe-n-unidades", pe.n_unidades != null ? String(pe.n_unidades) : "—");
    setVal("pe-precio", pe.precio_promedio != null ? formatearMoneda(pe.precio_promedio) : "—");
    setVal("pe-cvu", pe.cvu != null ? formatearMoneda(pe.cvu) : "—");
    setVal("pe-margen-unit", pe.margen_unitario != null ? formatearMoneda(pe.margen_unitario) : "—");

    // [E2/E3 · LISTA DUEÑO] Estructura de gastos: una fila por categoría de
    // egreso con tipo (fija/variable) y porción % — pinta estructura_gastos.
    const body = document.getElementById("pe-estructura-body");
    if (body) {
        const est = pe.estructura_gastos || [];
        body.innerHTML = est.length
            ? est.map(e => "<tr>" +
                "<td>" + String(e.categoria || "—").slice(0, 40) + "</td>" +
                "<td style='text-align:center'>" + (e.tipo === "fija" ? "🔒 Fija" : "🔀 Variable") + "</td>" +
                "<td style='text-align:right'>" + formatearMoneda(e.monto) + "</td>" +
                "<td style='text-align:right'>" + formatearPct(e.porcion_pct) + "</td></tr>").join("")
            : '<tr><td colspan="4" class="text-muted">—</td></tr>';
    }
    // [PBI · 09/09] Chips visuales de estructura de gastos en Análisis
    // (categoría + monto + porción %) — mismo estilo que Top 5 del Resumen.
    const chips = document.getElementById("pe-estructura-chips");
    if (chips) {
        const est = pe.estructura_gastos || [];
        chips.innerHTML = est.length
            ? est.map(e => {
                const icono = e.tipo === "fija" ? "🔒" : "🔀";
                return '<div class="pe-chip">' +
                    '<div class="pe-chip-label">' + icono + ' ' + String(e.categoria || "—").slice(0, 22) + '</div>' +
                    '<div class="pe-chip-monto">' + formatearMoneda(e.monto || 0) + '</div>' +
                    '<div class="pe-chip-pct">' + (e.porcion_pct != null ? e.porcion_pct.toFixed(1) + "% del gasto" : "—") + '</div>' +
                    '</div>';
            }).join("")
            : '<div class="text-muted small">Sin datos de estructura de gastos.</div>';
    }

    // [E-S2 · D-6] Desglose POR CONCEPTO con porción fija/variable heredada.
    const bodyCon = document.getElementById("pe-concepto-body");
    if (bodyCon) {
        const ec = pe.estructura_concepto || [];
        bodyCon.innerHTML = ec.length
            ? ec.map(e => "<tr>" +
                "<td>" + String(e.concepto || "—").slice(0, 40) + "</td>" +
                "<td class='text-muted small'>" + String(e.categoria || "—").slice(0, 30) + "</td>" +
                "<td style='text-align:center'>" + (e.tipo === "fija" ? "🔒" : "🔀") + "</td>" +
                "<td style='text-align:right;color:var(--zx-egresos)'>" + formatearMoneda(e.porcion_fija) + "</td>" +
                "<td style='text-align:right'>" + formatearMoneda(e.porcion_variable) + "</td>" +
                "<td style='text-align:right;font-weight:600'>" + formatearMoneda(e.total) + "</td></tr>").join("")
            : '<tr><td colspan="6" class="text-muted">—</td></tr>';
    }

    dibujarGraficoPE(pe);
    const wrap = document.getElementById("wrap-punto-equilibrio");
    if (wrap) wrap.style.display = "block";

    // [P-7 · 31/08] Waterfall de margen (datos del mismo `pe`, sin recalcular).
    dibujarWaterfallMargen(pe);
    // [P-8 · 31/08] Stacked costos fijos vs variables por categoría.
    dibujarStackedCostos(pe);
}

// [P-7 · 31/08] WATERFALL: Ingresos → −CV → −CF → = Utilidad.
function dibujarWaterfallMargen(pe) {
    const wrap = document.getElementById("wrap-waterfall-margen");
    const cv = document.getElementById("chartWaterfall");
    if (!wrap || !cv) return;
    if (!pe || pe.ingresos_brutos === undefined) { wrap.classList.add("d-none"); return; }
    const ing = Number(pe.ingresos_brutos) || 0;
    const cv_ = Number(pe.gastos_variables) || 0;
    const cf = Number(pe.gastos_fijos) || 0;
    const util = Number(pe.resultado_operativo) ?? (ing - cv_ - cf);
    if (ing <= 0) { wrap.classList.add("d-none"); return; }
    wrap.classList.remove("d-none");
    _destruirChart("chartWaterfall");
    new Chart(cv, {
        type: "bar",
        data: {
            labels: ["Ingresos", "− Costos Variables", "− Costos Fijos", "= Utilidad"],
            datasets: [{
                data: [ing, -cv_, -cf, util],
                backgroundColor: ["#16A34A", "#DC2626", "#D97706", "#5B0672"],
                borderWidth: 0,
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.label}: ${formatearMoneda(ctx.raw)}`,
                    },
                },
            },
            scales: {
                x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                y: { ticks: {
                        font: { size: 10 },
                        callback: v => formatearNum(v),  // sin $ para no saturar
                    } },
            },
            // Waterfall en barras absolutas: el número se lee del tooltip.
            layout: { padding: { top: 10 } },
        },
    });
}

// [P-8 · 31/08] STACKED: fijos vs variables por categoría de egreso.
function dibujarStackedCostos(pe) {
    const wrap = document.getElementById("wrap-stacked-costos");
    const cv = document.getElementById("chartStackedCostos");
    if (!wrap || !cv) return;
    const est = (pe && pe.estructura_gastos) || [];
    if (!est.length) { wrap.classList.add("d-none"); return; }
    wrap.classList.remove("d-none");
    _destruirChart("chartStackedCostos");
    // Una barra por categoría: fija (verde/gris) + variable (rojo) apiladas.
    const labels = est.map(e => String(e.categoria).slice(0, 22));
    const fijas = est.map(e => (e.tipo === "fija" ? (e.monto || 0) : 0));
    const varia = est.map(e => (e.tipo === "fija" ? 0 : (e.monto || 0)));
    new Chart(cv, {
        type: "bar",
        data: {
            labels,
            datasets: [
                { label: "Fijos", data: fijas, backgroundColor: "#5B0672", stack: "s" },
                { label: "Variables", data: varia, backgroundColor: "#7C3AED", stack: "s" },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: "bottom", labels: { font: { size: 11 } } },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: ${formatearMoneda(ctx.raw)}`,
                    },
                },
            },
            scales: {
                x: { stacked: true, grid: { display: false }, ticks: { font: { size: 9 } } },
                y: { stacked: true, ticks: {
                        font: { size: 9 },
                        callback: v => formatearNum(v),
                    } },
            },
        },
    });
}

// [PRIORIDAD 1] Gráfica del punto de equilibrio: Ingresos (precio·x) vs
// Costos totales (fijos + CVU·x); el cruce ocurre en (pe_unidades, pe_ventas).
// Si el margen unitario no es positivo, no existe PE → placeholder amigable.
function dibujarGraficoPE(pe) {
    const cv = document.getElementById("chartPE");
    if (!cv) return;
    const nota = document.getElementById("pe-grafica-nota");
    if (!(pe.precio_promedio > 0) || !(pe.margen_unitario > 0)) {
        mostrarPlaceholderGrafico("chartPE",
            "No hay punto de equilibrio: el margen unitario (precio promedio − CVU) no es positivo con estos datos.");
        if (nota) nota.textContent = "";
        return;
    }
    const xMax = Math.max(Number(pe.n_unidades) || 0, Math.ceil((pe.pe_unidades || 0) * 1.5), 10);
    const paso = Math.max(1, Math.ceil(xMax / 20));
    const xs = [];
    for (let x = 0; x <= xMax; x += paso) xs.push(x);
    // Datasets en formato {x, y} con escala x lineal (Chart.js 4) para que el
    // punto PE se ubique exactamente en el cruce de ambas líneas.
    const dIngresos = xs.map(x => ({ x, y: +(x * pe.precio_promedio).toFixed(2) }));
    const dCostos = xs.map(x => ({ x, y: +(pe.gastos_fijos + x * pe.cvu).toFixed(2) }));
    _crearChartTipo("chartPE", {
        type: "line",
        data: {
            datasets: [
                { label: "Ingresos", data: dIngresos, borderColor: colorSerie("ingresos"), backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0 },
                { label: "Costos totales", data: dCostos, borderColor: colorSerie("egresos"), backgroundColor: "transparent", borderWidth: 2, pointRadius: 0, tension: 0 },
                { label: "Punto de equilibrio", data: [{ x: pe.pe_unidades, y: pe.pe_ventas }], borderColor: "#7c3aed", backgroundColor: "#7c3aed", showLine: false, pointRadius: 6, pointHoverRadius: 8 },
            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: "nearest", intersect: false },
            plugins: {
                legend: { position: "top" },
                tooltip: {
                    callbacks: {
                        label: (ctx) => ctx.dataset.label === "Punto de equilibrio"
                            ? "PE: " + formatearNum(ctx.parsed.x, 1) + " unidades · " + formatearMoneda(ctx.parsed.y)
                            : ctx.dataset.label + ": " + formatearMoneda(ctx.parsed.y) + " (en " + ctx.parsed.x + " unid.)",
                    },
                },
            },
            scales: {
                x: { type: "linear", beginAtZero: true, title: { display: true, text: "Unidades" } },
                y: { beginAtZero: true, ticks: { callback: v => formatearNum(v, 0) } },
            },
        },
    }, "line");
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw("chartPE", () => dibujarGraficoPE(pe));
    }
    if (nota) nota.textContent =
        "Cruzas el punto de equilibrio con " + formatearNum(pe.pe_unidades, 1) +
        " unidades (" + formatearMoneda(pe.pe_ventas) + "). Unidades vendidas hasta ahora: " +
        formatearNum(pe.n_unidades, 0) + ".";
}
// [P0B · D-1] Depreciación mensual derivada (serie del backend) → tabla +
// mini-gráfica. Réplica del cuadro "Depreciación por Mes" del Excel.
function renderizarDepreciacion(serie) {
    const wrap = document.getElementById("wrap-depreciacion");
    if (!wrap) return;
    if (!serie || !serie.labels || !serie.labels.length) { wrap.classList.add("d-none"); return; }
    wrap.classList.remove("d-none");
    const body = document.getElementById("depreciacion-body");
    if (body) body.innerHTML = serie.labels.map((l, i) =>
        "<tr><td>" + l + "</td><td style='text-align:right'>" + formatearMoneda(serie.valores[i]) + "</td></tr>"
    ).join("");
    const total = serie.valores.reduce((a, b) => a + b, 0);
    const totEl = document.getElementById("depreciacion-total");
    if (totEl) totEl.textContent = "Total depreciación del período: " + formatearMoneda(total) + " · " + serie.labels.length + " meses con registro.";
    dibujarGraficoDepreciacion(serie);
}

function dibujarGraficoDepreciacion(serie) {
    const cv = document.getElementById("depreciacionChart");
    if (!cv) return;
    _crearChartTipo("depreciacionChart", {
        type: "bar",
        data: {
            labels: serie.labels,
            datasets: [{ label: "Depreciación", data: serie.valores,
                backgroundColor: colorColumna("Depreciación de equipos") || "#f59e0b", borderRadius: 5 }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => formatearMoneda(ctx.raw) } },
            },
            scales: { y: { beginAtZero: true, ticks: { callback: v => formatearNum(v, 0) } } },
        },
    }, "bar");
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw("depreciacionChart", () => dibujarGraficoDepreciacion(serie));
    }
}

// [P0B · D-2] Activos Fijos: tabla de equipos con totales (detección genérica).
// Fuente: data.activos_fijos ({equipos: [...], totales: {...}}), None si el
// bloque no es de activos fijos.
function renderizarActivosFijos(af) {
    const wrap = document.getElementById("wrap-activos-fijos");
    if (!wrap) return;
    if (!af || !af.equipos || !af.equipos.length) { wrap.classList.add("d-none"); return; }
    wrap.classList.remove("d-none");
    const body = document.getElementById("activos-fijos-body");
    if (body) body.innerHTML = af.equipos.map(e =>
        "<tr><td>" + String(e.codigo || "—") + "</td>" +
        "<td>" + String(e.nombre || "—").slice(0, 30) + "</td>" +
        "<td>" + String(e.fecha || "—").slice(0, 16) + "</td>" +
        "<td style='text-align:right'>" + formatearMoneda(e.costo) + "</td>" +
        "<td style='text-align:center'>" + (e.vida_util || 0) + "</td>" +
        "<td style='text-align:right'>" + formatearMoneda(e.salvamento) + "</td>" +
        "<td style='text-align:right'>" + formatearMoneda(e.dep_anual) + "</td>" +
        "<td style='text-align:right'>" + formatearMoneda(e.dep_mensual) + "</td></tr>"
    ).join("");
    const tot = document.getElementById("activos-fijos-total");
    if (tot && af.totales) {
        tot.innerHTML = "<td colspan='3'>TOTAL (" + (af.totales.n_equipos || 0) + " equipos)</td>" +
            "<td style='text-align:right'>" + formatearMoneda(af.totales.costo_total) + "</td><td></td>" +
            "<td></td><td style='text-align:right'>" + formatearMoneda(af.totales.dep_anual_total) + "</td>" +
            "<td style='text-align:right'>" + formatearMoneda(af.totales.dep_mensual_total) + "</td>";
    }
}

function obtenerPaletaColores(labels) {
    return labels.map(label =>
        colorColumna(String(label)) ||
        colorSerie(String(label)) ||
        _coloresCategoriaActual[String(label)] ||
        PALETA_DEFAULT[
            (String(label).split("").reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) >>> 0, 0)) %
            PALETA_DEFAULT.length
        ]
    );
}

// [Plan F · E1] Colores de serie dinámicos: Ingresos/Egresos personalizables
// desde Categorías Visibles (claves reservadas "__ingresos"/"__egresos",
// nunca colisionan con categorías reales). Fallback verde/rojo universal.
function colorSerie(tipo) {
    const clave = "__" + tipo;
    if (_coloresCategoriaActual[clave]) return _coloresCategoriaActual[clave];
    return tipo === "ingresos" ? "#16A34A" : "#DC2626";
}
function hexARgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return "rgba(" + ((n >> 16) & 255) + ", " + ((n >> 8) & 255) + ", " + (n & 255) + ", " + alpha + ")";
}

async function cambiarColorCategoria(categoria, colorHex) {
    _coloresCategoriaActual[categoria] = colorHex;
    if (!currentTablaId) return;
    // [Plan C v1.0.0] Persistir en AMBOS esquemas: colores_categoria (frontend legacy)
    // y color_por_serie (PDF R22). Fundacional §11.3: el mismo hex viaja a Chart.js y PDF.
    await Promise.all([
        fetch(`/api/tabla/${currentTablaId}/config`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ colores_categoria: _coloresCategoriaActual }),
        }),
        fetch(`/api/bloque/${currentTablaId}/config`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ color_por_serie: _coloresCategoriaActual }),
        }),
    ]);
    if (currentTablaId) cargarDashboard(currentTablaId);
}

// ─── Alertas configurables (E18) ─────────────────────────────────────────────
function evaluarAlertas(config, biz) {
    const alertas  = (config.alertas || []).filter(a => a.activa);
    const disparadas = [];
    alertas.forEach(a => {
        const valorActual = biz[a.metrica];
        if (valorActual === undefined) return;
        const disparada = a.condicion === "menor_que" ? valorActual < a.valor : valorActual > a.valor;
        if (disparada) disparadas.push({ ...a, valorActual });
    });
    const cont = document.getElementById("contenedor-alertas-disparadas");
    if (!cont) return;
    if (disparadas.length === 0) { cont.classList.add("d-none"); return; }
    cont.classList.remove("d-none");
    cont.innerHTML = disparadas.map(a => `
        <div class="alert alert-danger py-2 px-3 mb-1">
            ⚠ <strong>${a.metrica}</strong> ${a.condicion === "menor_que" ? "es menor a" : "supera"}
            ${a.valor} (actual: ${a.valorActual.toFixed(2)})
        </div>
    `).join("");
}

// ─── Filtro por categoría (E7) ──────────────────────────────────────────────
let _categoriaFiltrada = null;

function aplicarFiltroCategoria(categoria) {
    _categoriaFiltrada = categoria;
    const banner = document.getElementById("banner-filtro-categoria");
    const texto  = document.getElementById("texto-categoria-filtrada");
    if (banner && texto) {
        texto.textContent = categoria;
        banner.classList.remove("d-none");
    }
    aplicarFiltroAGGridPorCategoria(categoria);
    // Reflectir el filtro en la URL con replaceState para que el botón "Atrás"
    // no reintroduzca filtros descartados (Sección 6.3 v8.0.0).
    const params = new URLSearchParams(window.location.search);
    params.set("filtro", categoria);
    history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
}

function limpiarFiltroCategoria() {
    _categoriaFiltrada = null;
    document.getElementById("banner-filtro-categoria")?.classList.add("d-none");
    aplicarFiltroAGGridPorCategoria(null);
    // Eliminar el filtro de la URL con replaceState
    const params = new URLSearchParams(window.location.search);
    params.delete("filtro");
    history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
}

function limpiarTodosFiltros() {
    limpiarFiltroCategoria();
    aplicarPresetFecha("todo");
    Object.keys(_modulosVisiblesActual || {}).forEach(k => { _modulosVisiblesActual[k] = true; });
    if (currentTablaId) cargarDashboard(currentTablaId);
}

// ─── Tabla Pareto (E9) ──────────────────────────────────────────────────────
let _datosParetoActual = [];
let _ordenParetoCol = "monto";
let _ordenParetoAsc = false;

function renderizarTablaPareto(categoriasData) {
    _datosParetoActual = Array.isArray(categoriasData) ? categoriasData : [];
    _pintarTablaPareto();
}

function ordenarTablaPareto(columna) {
    _ordenParetoAsc = _ordenParetoCol === columna ? !_ordenParetoAsc : true;
    _ordenParetoCol = columna;
    _pintarTablaPareto();
}

function _pintarTablaPareto() {
    const tbody = document.getElementById("tbody-tabla-pareto");
    if (!tbody) return;
    const datos = [..._datosParetoActual].sort((a, b) => {
        const va = a[_ordenParetoCol], vb = b[_ordenParetoCol];
        const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
        return _ordenParetoAsc ? cmp : -cmp;
    });
    tbody.innerHTML = datos.map(c => {
        const colorCat = _coloresCategoriaActual[c.categoria] || obtenerPaletaColores([c.categoria])[0];
        return `
        <tr>
            <td><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${colorCat};margin-right:6px"></span>${c.categoria || ""}</td>
            <td>${formatearMoneda(c.monto)}</td>
            <td>${c.operaciones || 0}</td>
            <td>${c.porcentaje || 0}%</td>
        </tr>`;
    }).join("");
}

// ═══════════════════════════════════════════════════════════════
// GRÁFICOS MODO CLÍNICA
// ═══════════════════════════════════════════════════════════════

// [Plan F · 23/08] Selector de tipo de gráfico MOVIDO a
// src/static/js/chart_tipos.js (autocontenido): expone _crearChartTipo,
// _elegirTipoGrafico, _inyectarSelectorTipo y _TIPOS_PERMITIDOS en el scope
// global. Los dibujadores de este archivo lo usan para variedad visual
// (barras/línea/área/dona/torta/polar) sin tocar la lógica de datos.

// [Plan F · 23/08] Tendencia: Mensual | Anual | Rango (Desde/Hasta).
let _tendenciaPeriodo = "mes"; // "mes" | "anio" | "rango"
function cambiarTendenciaPeriodo(valor) {
    _tendenciaPeriodo = (valor === "anio") ? "anio" : ((valor === "rango") ? "rango" : "mes");
    try { sessionStorage.setItem("zenit_tend_periodo", _tendenciaPeriodo); } catch (_) {}
    if (_tendenciaPeriodo === "rango") {
        const barra = document.getElementById("barra-filtros-financieros");
        if (barra) barra.style.display = "flex";
        const desde = document.getElementById("sel-mes-desde");
        if (desde) {
            desde.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }
    if (typeof currentTablaId !== "undefined" && currentTablaId) cargarDashboard(currentTablaId);
}

// [Refactor P0] Datasets I/E/Margen compartidos: los usan la Tendencia
// (mainTrendChart) y el Resumen mensual (resumenChart) — UNA fuente.
function _datasetsIEMargen(serieIng, serieEgr, serieMargen) {
    const ingOff = _modulosVisiblesActual["__ingresos"] === false;
    const egrOff = _modulosVisiblesActual["__egresos"] === false;
    return [
        ...(ingOff ? [] : [{
            label: "Ingresos",
            data: serieIng.valores,
            backgroundColor: hexARgba(colorSerie("ingresos"), 0.75),
            borderRadius: 6,
            borderColor: colorSerie("ingresos"),
            borderWidth: 1,
            order: 2,
        }]),
        ...(egrOff ? [] : [{
            label: "Egresos",
            data: serieEgr.valores,
            backgroundColor: hexARgba(colorSerie("egresos"), 0.75),
            borderRadius: 6,
            borderColor: colorSerie("egresos"),
            borderWidth: 1,
            order: 2,
        }]),
        ...((ingOff || egrOff) ? [] : [{
            label: "Margen",
            data: serieMargen ? serieMargen.valores : [],
            type: "line",
            borderColor: "#7c3aed",
            borderWidth: 3,
            fill: false,
            pointRadius: 5,
            pointHoverRadius: 7,
            tension: 0.3,
            order: 1,
        }]),
    ];
}

function dibujarGraficoIngresosEgresos(serieIng, serieEgr, serieMargen) {
    const canvas = document.getElementById("mainTrendChart");
    if (!canvas) return;
    const labels = serieIng.labels;

    _crearChartTipo("mainTrendChart", {
        type: "bar",
        data: { labels, datasets: _datasetsIEMargen(serieIng, serieEgr, serieMargen) },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { display: true, position: "top" },
                tooltip: {
                    callbacks: {
                        label: (ctx) =>
                            `${ctx.dataset.label}: ${formatearMoneda(ctx.raw)}`,
                    },
                },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        // CORRECCIÓN (Medio/Alto): unificado a es-BO — mismo
                        // locale que formatearMoneda() y el resto del dashboard.
                        callback: (v) => `${_monedaActual} ${Number(v).toLocaleString("es-BO")}`,
                    },
                },
            },
        },
    }, "bar");
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw("mainTrendChart", () => dibujarGraficoIngresosEgresos(serieIng, serieEgr, serieMargen));
    }
}

// ─── Módulos/categorías togglables (E4, E5, E14) ─────────────────────────────

let _modulosVisiblesActual = {};

// [Plan F · Fix admin] Columnas del dataset (tabla azul origen): cada
// columna real del Excel con checkbox (activa) y color propio.
function colorColumna(nombre) {
    if (!nombre) return null;
    // [CENTRALIZACIÓN v2] Para columnas-serie (Ingresos/Egresos) el color se
    // lee EXCLUSIVAMENTE de la clave global (__ingresos/__egresos).
    const sk = _serieKeyDeNombre(nombre);
    if (sk && _coloresCategoriaActual[sk]) return _coloresCategoriaActual[sk];
    // [MOTOR ÚNICO] Resto: llave = nombre pelado (sin prefijo col:).
    return _coloresCategoriaActual[nombre] || null;
}

function renderizarColumnasDataset() {
    const cont = document.getElementById("contenedor-columnas-dataset");
    if (!cont) return;
    const perfil = _perfilColumnasActual || {};
    const cols = Object.keys(perfil);
    if (!cols.length) { cont.innerHTML = ""; return; }
    cont.innerHTML = cols.map(colRaw => {
        const col = String(colRaw);
        const visible = _modulosVisiblesActual["col:" + col] !== false;
        const color = colorColumna(col) || _colorDefectoEstable(col);
        const tipo = (perfil[col] && perfil[col].tipo) || "";
        const icono = tipo === "numerico" ? "#" : (tipo === "fecha" ? "📅" : "🏷");
        return `<label class="d-flex align-items-center gap-2 border rounded px-2 py-1 mb-1" style="cursor:pointer;background:${visible ? "#eff6ff" : "#f1f5f9"}"><input type="checkbox" data-columna="${col.replace(/"/g, "&quot;")}" ${visible ? "checked" : ""} onchange="toggleColumnaDataset('${col.replace(/'/g, "\'")}')"><input type="color" class="form-control form-control-color form-control-color-sm border-0" value="${color}" onchange="cambiarColorColumna('${col.replace(/'/g, "\'")}', this.value)" style="width:22px;height:22px;padding:0;cursor:pointer;" title="Color de la columna ${col}"><span class="small">${icono} ${col}</span></label>`;
    }).join("");

    // [F-15 · V-3 etapa 3] Sincronizar el selector de color del Eje Y (fila
    // destacada) con la columna Y actual: muestra su nombre y su color, y al
    // cambiarlo persiste vía R22 (mismo camino que cambiarColorColumna).
    const selEjeY = document.getElementById("color-eje-y");
    const lblEjeY = document.getElementById("fila-eje-y-actual");
    if (lblEjeY) lblEjeY.textContent = _ejeYActual || "—";
    if (selEjeY && _ejeYActual) {
        selEjeY.value = colorColumna(_ejeYActual) || _colorDefectoEstable(_ejeYActual);
        selEjeY.onchange = () => cambiarColorColumna(_ejeYActual, selEjeY.value);
    }
}

async function toggleColumnaDataset(col) {
    const clave = "col:" + col;
    _modulosVisiblesActual[clave] = _modulosVisiblesActual[clave] === false;
    if (currentTablaId) {
        try {
            await fetch(`/api/tabla/${currentTablaId}/config`, {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ modulos_visibles: _modulosVisiblesActual }),
            });
        } catch (_) { /* no bloquear UI */ }
    }
    if (currentTablaId) cargarDashboard(currentTablaId);
}

async function cambiarColorColumna(col, colorHex) {
    // [CENTRALIZACIÓN v2] UN SOLO sistema de claves:
    //   - Columnas-serie (Ingresos/Egresos) → color vive SOLO en
    //     __ingresos/__egresos; la clave legacy col:<Nombre> SE ELIMINA.
    //   - Resto de columnas → col:<Nombre> como siempre.
    const sk = _serieKeyDeNombre(col);
    if (sk) {
        _coloresCategoriaActual[sk] = colorHex;
    } else {
        _coloresCategoriaActual[col] = colorHex;
    }
    // [MOTOR ÚNICO] Limpiar cualquier llave legacy col:<Nombre> asociada.
    delete _coloresCategoriaActual["col:" + col];
    if (!currentTablaId) return;
    // Persistir en AMBOS esquemas (colores_categoria legacy + color_por_serie
    // canónico R22 que consume el PDF).
    await Promise.all([
        fetch(`/api/tabla/${currentTablaId}/config`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ colores_categoria: _coloresCategoriaActual }),
        }),
        fetch(`/api/bloque/${currentTablaId}/config`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ color_por_serie: _coloresCategoriaActual }),
        }),
    ]);
    cargarDashboard(currentTablaId);
}

// [Fase dedup] Mapea un nombre de columna real a su clave de serie global.
// Devuelve "__ingresos"/"__egresos" o null si el nombre no es una serie.
function _serieKeyDeNombre(nombre) {
    const n = String(nombre || "").trim().toLowerCase();
    if (n === "ingresos" || n === "ingreso") return "__ingresos";
    if (n === "egresos" || n === "egreso") return "__egresos";
    return null;
}

function renderizarChipsModulos(categoriasData, configGuardada, categoriasDisponibles) {
    // [Plan F-2 - Fase 6] Checkboxes de filtro visual (Fundacional §6.1 "Filtros
    // por checkbox"). [Fix C-1] Marcar/desmarcar recarga el dashboard con
    // `excluir` -- el backend recalcula KPIs, serie, tabla y anomalías (§6.1).
    const cont = document.getElementById("contenedor-chips-modulos");
    if (!cont) return;

    _modulosVisiblesActual = configGuardada.modulos_visibles || {};

    // [Fix C-1] El backend devuelve `categorias_disponibles`: el catálogo
    // COMPLETO de columna_x (incluye las desmarcadas) para que el usuario
    // pueda volver a marcarlas. El % del total se toma de categoriasData
    // (los puntos reales); las excluidas muestran 0.
    const pctPorCat = {};
    (categoriasData || []).forEach(c => {
        if (c && c.categoria !== undefined && c.categoria !== null) pctPorCat[String(c.categoria)] = c.porcentaje;
    });
    const catalogo = (Array.isArray(categoriasDisponibles) && categoriasDisponibles.length)
        ? categoriasDisponibles
        : (categoriasData || []).map(c => c.categoria);

    // [CENTRALIZACIÓN DEFINITIVA · 23/08] Los valores de TIPO (ingreso/egreso)
    // NO son categorías: su control ÚNICO es la franja "🎨 Colores de series"
    // (toggle+color global). Si la columna analizada es Tipo, estos valores
    // llegaban como chips y se VEÍAN como duplicados de 💰/💸. Se excluyen.
    const catalogoFiltrado = catalogo.filter(c => !_esValorTipoFinanciero(c));

    // [Fase dedup 23/08] Las series 💰/💸 ya NO viven en "Filtrar valores"
    // (duplicaban visualmente a columnas reales llamadas Ingresos/Egresos).
    // Ahora tienen su propia franja única "🎨 Colores de series" arriba.
    cont.innerHTML = catalogoFiltrado.map(catRaw => {
        const categoria = String(catRaw);
        const visible = _modulosVisiblesActual[categoria] !== false;
        const colorActual = _coloresCategoriaActual[categoria] || _colorDefectoEstable(categoria);
        const pct = pctPorCat[categoria] !== undefined ? pctPorCat[categoria] : 0;
        return `
            <label class="d-flex align-items-center gap-2 border rounded px-2 py-1 mb-1"
                   style="cursor:pointer;background:${visible ? "#f8fafc" : "#f1f5f9"}">
                <input type="checkbox"
                       data-categoria="${categoria.replace(/"/g, '&quot;')}"
                       ${visible ? "checked" : ""}
                       onchange="toggleModuloCategoria('${categoria.replace(/'/g, "\\'")}')">
                <input type="color"
                       class="form-control form-control-color form-control-color-sm border-0"
                       value="${colorActual}"
                       onchange="cambiarColorCategoria('${categoria.replace(/'/g, "\\'")}', this.value)"
                       style="width: 22px; height: 22px; padding: 0; cursor: pointer;"
                       title="Cambiar color de ${categoria}">
                <span class="small">${categoria} · ${pct}%</span>
            </label>
        `;
    }).join("");
    renderizarSeriesGlobales();
    renderizarColumnasDataset();
}

// [CENTRALIZACIÓN DEFINITIVA · 23/08] El control de las series financieras
// (💰/💸) vive SIEMPRE en la franja "🎨 Colores de series" — con toggle y
// color GLOBAL. Las columnas reales del Excel se pintan aparte en su lista;
// si una columna se llama igual que una serie, su picker de color actúa
// sobre la MISMA clave (__ingresos/__egresos) vía cambiarColorColumna().
function renderizarSeriesGlobales() {
    const fila = document.getElementById("fila-series-globales");
    const cont = document.getElementById("contenedor-series-globales");
    if (!cont) return;
    const series = [
        { clave: "__ingresos", nombre: "💰 Ingresos", def: "#16A34A" },
        { clave: "__egresos", nombre: "💸 Egresos", def: "#DC2626" },
    ];
    if (fila) fila.style.display = "flex";
    cont.innerHTML = series.map(s => {
        const visible = _modulosVisiblesActual[s.clave] !== false;
        return `
        <label class="d-flex align-items-center gap-1 border rounded px-2 py-1"
               style="cursor:pointer;background:${visible ? "#f0fdf4" : "#fee2e2"}"
               title="${visible ? "Visible" : "Oculta"} en TODO el dashboard (Resumen/Avanzado/EDA)">
            <input type="checkbox" ${visible ? "checked" : ""}
                onchange="toggleSerieGlobal('${s.clave}')">
            <input type="color" class="form-control form-control-color form-control-color-sm border-0"
                value="${_coloresCategoriaActual[s.clave] || s.def}"
                onchange="cambiarColorCategoria('${s.clave}', this.value)"
                style="width:22px;height:22px;padding:0;cursor:pointer;">
            <span class="small fw-semibold">${s.nombre}</span>
        </label>`;
    }).join("");
}

// [CENTRALIZACIÓN DEFINITIVA] True si un valor de categoría es en realidad
// un literal de TIPO financiero (Ingreso/Egreso) — se excluye de los chips
// porque su control de toggle/color es la franja de series.
function _esValorTipoFinanciero(valor) {
    const v = String(valor || "").trim().toLowerCase();
    return ["ingreso", "ingresos", "egreso", "egresos"].includes(v);
}

// ─── [Fase 8 · T8.2] Detalles colapsables (tabla bajo la gráfica) ────────────
// Dashboard = visual primero; el detalle de filas queda plegado por defecto
// y se abre a un clic. Estado persistido por sección (localStorage).
function _detalleEstado(wrapId) {
    try {
        const est = JSON.parse(localStorage.getItem("zenit_detalles") || "{}");
        return est[wrapId] === true; // default: OCULTO
    } catch (_) { return false; }
}
function _detalleGuardar(wrapId, visible) {
    try {
        const est = JSON.parse(localStorage.getItem("zenit_detalles") || "{}");
        est[wrapId] = visible;
        localStorage.setItem("zenit_detalles", JSON.stringify(est));
    } catch (_) { /* no bloquear */ }
}
function _alternarDetalle(wrapId, btn) {
    const wrap = document.getElementById(wrapId);
    if (!wrap) return false;
    const visible = wrap.style.display !== "none";
    wrap.style.display = visible ? "none" : "";
    if (btn) btn.innerHTML = visible ? "📄 Detalle ▾" : "📄 Detalle ▴";
    _detalleGuardar(wrapId, !visible);
    return false;
}
function _btnDetalleHtml(wrapId) {
    return '<button class="btn btn-sm btn-outline-secondary ms-auto btn-detalle" onclick="return _alternarDetalle(\'' + wrapId + '\', this)">'
        + (_detalleEstado(wrapId) ? "📄 Detalle ▴" : "📄 Detalle ▾") + "</button>";
}
function _aplicarEstadoDetalle(wrapId) {
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;
    wrap.style.display = _detalleEstado(wrapId) ? "" : "none";
}
// Monta botón+estado en las cards con tabla de detalle (idempotente).
function _montarColapsables() {
    [["wrap-desglose-concepto", "wrap-tabla-concepto"],
     ["wrap-margen-entidad", "wrap-tabla-margen"]].forEach(par => {
        const card = document.getElementById(par[0]);
        const header = card && card.querySelector(".z-card-header");
        if (!card || !header) { _aplicarEstadoDetalle(par[1]); return; }
        if (!header.querySelector(".btn-detalle")) header.insertAdjacentHTML("beforeend", _btnDetalleHtml(par[1]));
        _aplicarEstadoDetalle(par[1]);
    });
    // Resúmenes I/E del tab Avanzado (títulos fw-bold, sin z-card-header).
    [["wrap-res-ing"], ["wrap-res-egr"]].forEach(par => {
        const wrap = document.getElementById(par[0]);
        if (!wrap) { _aplicarEstadoDetalle(par[0]); return; }
        const titulo = wrap.querySelector(".fw-bold");
        if (titulo && !titulo.querySelector(".btn-detalle")) titulo.insertAdjacentHTML("beforeend", _btnDetalleHtml(par[0]));
        _aplicarEstadoDetalle(par[0]);
    });
}

// [Fase dedup] Prender/apagar una serie financiera COMPLETA: la ocultamos
// excluyendo sus valores de la columna Tipo (C-1 multi-columna) — afecta a
// KPIs, tendencia, donuts, desgloses y Avanzado por igual.
async function toggleSerieGlobal(clave) {
    _modulosVisiblesActual[clave] = _modulosVisiblesActual[clave] === false;
    if (currentTablaId) {
        try {
            await fetch(`/api/tabla/${currentTablaId}/config`, {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ modulos_visibles: _modulosVisiblesActual }),
            });
        } catch (_) { /* no bloquear UI */ }
    }
    if (currentTablaId) cargarDashboard(currentTablaId);
}

async function toggleModuloCategoria(categoria) {
    _modulosVisiblesActual[categoria] = _modulosVisiblesActual[categoria] === false;

    // Actualizar el checkbox correspondiente
    document.querySelectorAll("#contenedor-chips-modulos input[type=checkbox]").forEach(cb => {
        if (cb.dataset.categoria === categoria) cb.checked = _modulosVisiblesActual[categoria] !== false;
    });

    // [Plan C v1.0.0] Persistir modulos_visibles en config para que sobreviva recargas.
    // config_utils.py hace fusión superficial — enviar el sub-dict COMPLETO.
    if (currentTablaId) {
        try {
            await fetch(`/api/tabla/${currentTablaId}/config`, {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ modulos_visibles: _modulosVisiblesActual }),
            });
        } catch (_) { /* no bloquear UI */ }
    }

    // [Fix C-1] El filtro ya NO usa POST /filtrar (su respuesta se descartaba).
    // Recargar el dashboard: cargarDashboard() construye `?excluir=` desde
    // _modulosVisiblesActual y el backend recalcula KPIs, serie, tabla y
    // anomalías con el recorte en memoria (§6.1) — consistente en TODO.
    if (currentTablaId) cargarDashboard(currentTablaId);
}

function dibujarGraficoDonutCategorias(canvasId, categoriasData, titulo) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) { console.warn(`Canvas #${canvasId} no encontrado.`); return; }

    // Acepta list[dict] nativamente (Sesión 1.7)
    let items = Array.isArray(categoriasData) ? categoriasData : [];

    // [G-FASE 4 · ajuste] Una composición puede traer de 2 hasta 20+ categorías.
    // Para que la dona se vea bien SIEMPRE (segmentos legibles + leyenda corta),
    // se consolidan las categorías más pequeñas en "Otros" cuando superan el tope.
    const MAX_SEGMENTOS = 8;
    if (items.length > MAX_SEGMENTOS) {
        const ordenados = [...items].sort(
            (a, b) => (Number(b.monto) || 0) - (Number(a.monto) || 0),
        );
        const top = ordenados.slice(0, MAX_SEGMENTOS - 1);
        const restoMonto = ordenados
            .slice(MAX_SEGMENTOS - 1)
            .reduce((s, c) => s + (Number(c.monto) || 0), 0);
        items = top.concat({ categoria: "Otros", monto: restoMonto });
    }

    const labels  = items.map(c => c.categoria);
    const valores = items.map(c => Number(c.monto) || 0);
    const total = valores.reduce((a, b) => a + b, 0);

    const COLORES = obtenerPaletaColores(labels);

    _crearChartTipo(canvasId, {
        type: "doughnut",
        data: {
            labels,
            datasets: [{
                data: valores,
                backgroundColor: COLORES,
                borderColor: "#fff",
                borderWidth: 1,
                cutout: "62%",
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            onClick: (evt, elementos) => {
                if (elementos.length === 0) return;
                aplicarFiltroCategoria(labels[elementos[0].index]);
            },
            plugins: {
                legend: {
                    position: "bottom",
                    labels: { padding: 6, boxWidth: 12, font: { size: 10 } },
                },
                title: {
                    display: false,
                    text: titulo,
                    font: { size: 13, weight: "600" },
                },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const pct = total > 0
                                ? ((ctx.raw / total) * 100).toFixed(1)
                                : "0.0";
                            return `${ctx.label}: ${formatearMoneda(ctx.raw)} (${pct}%)`;
                        },
                    },
                },
            },
        },
    }, "doughnut");
    if (typeof _registrarRedraw === "function") {
        _registrarRedraw(canvasId, () => dibujarGraficoDonutCategorias(canvasId, categoriasData, titulo));
    }
}

async function guardarMapeo() {
    // R19 — Llama PATCH /api/tabla/<id>/mapeo y luego recarga el dashboard
    const errBox = document.getElementById("mapeo-error");
    if (errBox) errBox.classList.add("d-none");

    const payload = {
        col_monto:     document.getElementById("mapeo-sel-monto")?.value     || null,
        col_fecha:     document.getElementById("mapeo-sel-fecha")?.value      || null,
        col_categoria: document.getElementById("mapeo-sel-categoria")?.value  || null,
        col_tipo:      document.getElementById("mapeo-sel-tipo")?.value       || null,
    };

    try {
        const res = await fetch(`/api/tabla/${currentTablaId}/mapeo`, {
            method:  "PATCH",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload),
        });
        const data = await res.json();

        if (!res.ok) {
            const msg = data.error || "Error al guardar la configuracion.";
            if (errBox) {
                errBox.textContent = msg;
                errBox.classList.remove("d-none");
            }
            return;
        }

        // Cerrar modal y recargar dashboard con el nuevo mapeo (R19)
        if (typeof cerrarModal === "function") {
            cerrarModal("modalMapeoColumnas");
        }

        const banner = document.getElementById("banner-mapeo-pendiente");
        if (banner) banner.classList.add("d-none");

        // Recargar el dashboard para mostrar los graficos
        if (typeof cargarDashboard === "function" && currentTablaId) {
            cargarDashboard(currentTablaId);
        }

    } catch (e) {
        console.error("Error en guardarMapeo:", e);
        if (errBox) {
            errBox.textContent = "Error de conexion. Intenta de nuevo.";
            errBox.classList.remove("d-none");
        }
    }
}

// ─── Navegador de importaciones/hojas (E1) ───────────────────────────────────

// ─── Filtro de fechas (E3) ────────────────────────────────────────────────────

let _filtroFechaActual = { desde: null, hasta: null };
let _agrupacionActual = "mes";

function aplicarPresetFecha(preset) {
    const hoy = new Date();
    let desde = null, hasta = null;

    if (preset === "mes_actual") {
        desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
        hasta = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
    } else if (preset === "mes_anterior") {
        desde = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
        hasta = new Date(hoy.getFullYear(), hoy.getMonth(), 0);
    } else if (preset === "trimestre") {
        const trimestreInicio = Math.floor(hoy.getMonth() / 3) * 3;
        desde = new Date(hoy.getFullYear(), trimestreInicio, 1);
        hasta = hoy;
    } else if (preset === "año") {
        desde = new Date(hoy.getFullYear(), 0, 1);
        hasta = hoy;
    }
    // preset === "todo": desde y hasta quedan null

    _filtroFechaActual.desde = desde ? desde.toISOString().slice(0, 10) : null;
    _filtroFechaActual.hasta = hasta ? hasta.toISOString().slice(0, 10) : null;

    document.getElementById("filtro-fecha-desde").value = _filtroFechaActual.desde || "";
    document.getElementById("filtro-fecha-hasta").value = _filtroFechaActual.hasta || "";

    if (currentTablaId) cargarDashboard(currentTablaId);
}

// ─── AG Grid de registros completos (E13) ────────────────────────────────────

let _gridRegistros = null;
let _gridApiRegistros = null;   // [fix] API de AG Grid v30.2.1 — setRowData/exportDataAsCsv
let _registrosOriginales = [];
let _mapeoGrid = {};            // [Plan E] mapeo real del bloque para filtros

async function cargarGridRegistros(tablaId) {
    try {
        // [Frente C · E3-global] La grilla respeta los filtros financieros globales
        let url = `/api/tabla/${tablaId}/registros?todas=1`;
        if (_filtroMesActual) url += `&mes=${encodeURIComponent(_filtroMesActual)}`;
        if (_filtroTipoActual) url += `&tipo=${encodeURIComponent(_filtroTipoActual)}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();

        _registrosOriginales = data.registros;
        _mapeoGrid = data.mapeo || {};

        const avisoTrunc = document.getElementById("aviso-grid-truncado");
        if (data.truncado) {
            avisoTrunc.textContent =
                `Mostrando las primeras ${data.registros.length.toLocaleString()} de ${data.total_filas.toLocaleString()} filas.`;
            avisoTrunc.classList.remove("d-none");
        } else {
            avisoTrunc.classList.add("d-none");
        }

        const columnDefs = data.columnas.map(col => ({
            field: col, sortable: true, filter: true, resizable: true,
        }));

        const div = document.getElementById("grid-registros-completo");
        if (_gridRegistros) { try { _gridRegistros.destroy(); } catch (e) {} }

        // [fix] AG Grid Community 30.2.1: `new agGrid.Grid` expone la API en
        // el objeto retornado (`.api`), NO `setGridOption` (API de v31+).
        _gridRegistros = new agGrid.Grid(div, {
            columnDefs,
            rowData:           data.registros,
            pagination:        true,
            paginationPageSize: 25,
            defaultColDef:     { flex: 1, minWidth: 100 },
        });
        _gridApiRegistros = _gridRegistros.api || _gridRegistros;
    } catch (e) {
        console.error("Error cargando grid de registros:", e);
    }
}

function aplicarFiltroRapidoGrid(tipo) {
    if (!_gridRegistros) return;
    // [Plan E] Usar el mapeo real del bloque (col_tipo, col_monto), NO regex.
    const colTipo  = _mapeoGrid.col_tipo;
    const colMonto = _mapeoGrid.col_monto;

    let filtrados = _registrosOriginales;
    let aviso = "";
    if (tipo === "ingresos" || tipo === "egresos") {
        if (!colTipo) {
            aviso = "Configura la columna <strong>Tipo</strong> en el mapeo de este dataset para filtrar por Ingreso/Egreso.";
        } else {
            const valor = tipo === "ingresos" ? "Ingreso" : "Egreso";
            filtrados = _registrosOriginales.filter(r => String(r[colTipo] || "").toLowerCase() === valor.toLowerCase());
        }
    } else if (tipo === "montos_altos") {
        if (colMonto) {
            filtrados = _registrosOriginales.filter(r => Number(r[colMonto]) > 1000);
        } else {
            aviso = "Configura la columna <strong>Monto</strong> en el mapeo para filtrar.";
        }
    }
    // "todos" → sin filtro
    const avisoTrunc = document.getElementById("aviso-grid-truncado");
    if (avisoTrunc) {
        avisoTrunc.innerHTML = aviso;
        avisoTrunc.classList.toggle("d-none", !aviso);
    }
    // [fix] AG Grid v30.2.1: usar la API capturada (setRowData), no setGridOption (v31+)
    if (_gridApiRegistros) _gridApiRegistros.setRowData(filtrados);
}

function aplicarFiltroAGGridPorCategoria(categoria) {
    if (!_gridRegistros) return;
    if (!categoria) {
        if (_gridApiRegistros) _gridApiRegistros.setRowData(_registrosOriginales);
        return;
    }
    const colCat = Object.keys(_registrosOriginales[0] || {}).find(c => /categoria/i.test(c));
    if (!colCat) return;
    if (_gridApiRegistros) {
        _gridApiRegistros.setRowData(
            _registrosOriginales.filter(r => r[colCat] === categoria)
        );
    }
}

function exportarGridCSV() {
    if (!_gridRegistros) return;
    if (_gridApiRegistros) _gridApiRegistros.exportDataAsCsv({ fileName: `registros_zenit_${currentTablaId}.csv` });
}

// ─── Reporte EDA como pestaña (Tarea 3) ─────────────────────────────────
// Carga el HTML de fg-data-profiling en un iframe dentro de la pestaña
// "📊 Reporte EDA", sin salir de la app. Reemplaza al botón del topbar.
async function cargarTabEDA() {
    if (!currentTablaId) return;
    const iframe = document.getElementById("eda-iframe");
    const loading = document.getElementById("eda-loading");
    if (!iframe || !loading) return;

    // Mostrar spinner
    iframe.style.display = "none";
    loading.style.display = "block";
    loading.innerHTML = '<div class="spinner-border text-purple mb-3" role="status"></div><p class="text-muted">Verificando disponibilidad del reporte EDA...</p>';

    try {
        let intentos = 0;
        const MAX = 15;
        while (intentos < MAX) {
            const res = await fetch(`/api/dashboard/${currentTablaId}/eda`);
            const data = await res.json();
            if (data.estado === "listo") {
                if (data.ruta_html) {
                    iframe.src = `/static/reports/bloque_${currentTablaId}.html`;
                    // [C-2c] Auto-alto del iframe (same-origin) elimina el scroll
                    // anidado (doble rueda). La navbar/footer YData se ocultan vía
                    // CSS de integración inyectado en el reporte (C-2a).
                    iframe.onload = function () {
                        try {
                            const doc = iframe.contentDocument || iframe.contentWindow.document;
                            const alto = doc && doc.body ? doc.body.scrollHeight : 0;
                            iframe.style.height = (alto > 0 ? alto : 480) + "px";
                        } catch (e) {
                            iframe.style.height = "480px";
                        }
                        iframe.style.display = "block";
                        loading.style.display = "none";
                    };
                } else {
                    loading.innerHTML = '<p class="text-muted p-5">Este bloque no tiene datos para generar un reporte EDA.</p>';
                }
                return;
            } else if (data.estado === "error") {
                loading.innerHTML = `<p class="text-danger p-5">Error: ${data.error || "Desconocido"}. <button class="btn btn-sm btn-outline-danger" onclick="cargarTabEDA()">Reintentar</button></p>`;
                return;
            } else if (data.estado === "en_progreso") {
                intentos++;
                loading.innerHTML = `<div class="spinner-border text-purple mb-3" role="status"></div><p class="text-muted">Generando reporte EDA... (${intentos}/${MAX})</p>`;
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        loading.innerHTML = '<p class="text-warning p-5">El reporte está tardando más de lo esperado. <button class="btn btn-sm btn-outline-warning" onclick="cargarTabEDA()">Reintentar</button></p>';
    } catch (e) {
        loading.innerHTML = '<p class="text-danger p-5">Error de conexión. <button class="btn btn-sm btn-outline-danger" onclick="cargarTabEDA()">Reintentar</button></p>';
    }
}

// ─── Reporte EDA (Ñ-1) ───────────────────────────────────────────────────────
// [Fase Ñ-1] Eliminada `abrirReporteEDA()` (abría window.open). El reporte EDA
// se ve SIEMPRE incrustado en el tab "📊 Reporte EDA" vía cargarTabEDA() +
// iframe. El botón del topbar ahora delegada a ese tab (dashboard.html).

// [Fase Ñ-3] Resumen EDA en español, para gerentes: estadísticas del motor
// propio (KPIs) mostradas sobre el iframe del reporte.
function renderizarResumenEDA(data) {
    const kpis = (data && data.kpis) || null;
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
    };
    set("eda-n",    kpis ? formatearNum(kpis.conteo, 0) : "—");
    set("eda-suma", kpis ? formatearMoneda(kpis.suma) : "—");
    set("eda-prom", kpis ? formatearMoneda(kpis.promedio) : "—");
    set("eda-max",  kpis ? formatearMoneda(kpis.maximo) : "—");
    const nota = document.getElementById("eda-nota");
    if (nota) {
        nota.textContent = kpis && kpis.columna
            ? `El análisis estadístico se hace sobre la columna «${kpis.columna}». El reporte EDA completo (abajo) examina todas las columnas: tipos de dato, valores faltantes, correlaciones y distribución.`
            : "El reporte EDA examina todas las columnas del bloque: tipos de dato, valores faltantes, correlaciones y distribución.";
    }
}

// ─── Fase Q: plantillas por dominio (aviso opcional + persistencia) ─────────
let _plantillaDetectadaActual = null;

// Mapeo módulo sugerido → clave de graficos_visibles (para "Usar plantilla").
const _MAPEO_MODULO_VISIBLE = {
    tendencia: "trend_visible", desglose: "desglose_visible",
    estadisticas: "stats_visible", rankings: "rankings_visible",
    anomalias: "anomalies_visible", registros: "registros_visible",
};

function gestionarAvisoPlantilla(data) {
    _plantillaDetectadaActual = (data && data.plantilla_detectada) || null;
    const banner = document.getElementById("aviso-plantilla");
    if (!banner) return;
    const config = (data && data.config) || {};
    // Si ya se decidió (usada o descartada), no volver a preguntar.
    if (!_plantillaDetectadaActual || config.plantilla_seleccionada) {
        banner.classList.add("d-none");
        return;
    }
    const d = _plantillaDetectadaActual;
    document.getElementById("plantilla-nombre").textContent =
        d.dominio.charAt(0).toUpperCase() + d.dominio.slice(1);
    document.getElementById("plantilla-modulos").textContent =
        (d.modulos || []).join(", ") || "—";
    banner.classList.remove("d-none");
}

async function aplicarPlantilla() {
    const d = _plantillaDetectadaActual;
    if (!d || !currentTablaId) return;
    try {
        const cfg = await cargarConfigBloque(currentTablaId);
        const gv = Object.assign({}, cfg.graficos_visibles || {});
        // Sugerencia: activa los módulos recomendados, sin forzar a ocultar otros.
        (d.modulos || []).forEach(m => {
            const k = _MAPEO_MODULO_VISIBLE[m];
            if (k) gv[k] = true;
        });
        const cuerpo = { plantilla_seleccionada: d.dominio };
        if (Object.keys(gv).length) cuerpo.graficos_visibles = gv;
        await fetch(`/api/bloque/${currentTablaId}/config`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(cuerpo),
        });
        aplicarVisibilidadGuardada(Object.assign({}, cfg, {
            graficos_visibles: gv, plantilla_seleccionada: d.dominio,
        }));
    } catch (_) { /* no romper si falla */ }
    const b = document.getElementById("aviso-plantilla");
    if (b) b.classList.add("d-none");
}

async function descartarPlantilla() {
    if (currentTablaId) {
        try {
            await fetch(`/api/bloque/${currentTablaId}/config`, {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ plantilla_seleccionada: "descartada" }),
            });
        } catch (_) { /* no romper */ }
    }
    const b = document.getElementById("aviso-plantilla");
    if (b) b.classList.add("d-none");
}

// ─── Fase O-5: estados vacío y de carga ──────────────────────────────────────
function mostrarEstadoVacio() {
    const el = document.getElementById("estado-vacio");
    if (el) el.classList.remove("d-none");
}

function ocultarEstadoVacio() {
    const el = document.getElementById("estado-vacio");
    if (el) el.classList.add("d-none");
}

// ─── P-13 · 09/09: panel de calidad de datos (perfil de columnas) ──────────
// Puebla la card "Calidad de datos" con el perfil de columnas del contrato:
// tipo, valores únicos, % vacíos, es_identificador. Resumen ejecutivo arriba.
function renderizarCalidadDatos(data) {
    const wrap = document.getElementById("wrap-calidad-datos");
    const body = document.getElementById("calidad-body");
    const resumen = document.getElementById("calidad-resumen");
    if (!wrap || !body) return;
    const perfil = data && data.perfil_columnas;
    if (!perfil) { wrap.classList.add("d-none"); return; }
    const cols = Object.values(perfil);
    if (!cols.length) { wrap.classList.add("d-none"); return; }
    wrap.classList.remove("d-none");
    const sub = document.getElementById("calidad-subtitulo");
    if (sub) sub.textContent = `${cols.length} columnas · ${cols[0].total_filas ?? "—"} filas`;
    let filasHtml = cols.map(c => {
        const tipoIcon = c.tipo === "numerico" ? "#" : (c.tipo === "fecha" ? "📅" : (c.tipo === "booleano" ? "⚪" : "🏷"));
        const pctVacios = c.nulos_pct != null ? (Number(c.nulos_pct) * 100) : null;
        const pctTxt = pctVacios !== null ? Math.round(pctVacios) + "%" : "—";
        const vaciosCls = (pctVacios !== null && pctVacios >= 50) ? "color:#DC2626;font-weight:700" : "";
        const idTxt = c.es_identificador ? "🔑 Sí" : "—";
        return `<tr>
            <td style="text-align:left">${tipoIcon} <b>${String(c.nombre || "").slice(0, 28)}</b></td>
            <td style="text-align:center">${c.tipo || "—"}</td>
            <td style="text-align:right">${c.cardinalidad ?? "—"}</td>
            <td style="text-align:right">${c.nulos_count ?? "—"}</td>
            <td style="text-align:right;${vaciosCls}">${pctTxt}</td>
            <td style="text-align:center">${idTxt}</td>
        </tr>`;
    }).join("");
    body.innerHTML = filasHtml;
    // Resumen ejecutivo: % de columnas con vacíos, cantidad de identificadores.
    const conVacios = cols.filter(c => (c.nulos_pct || 0) > 0);
    const ids = cols.filter(c => c.es_identificador);
    const numCols = cols.filter(c => c.tipo === "numerico").length;
    const totalVacios = cols.reduce((s, c) => s + (c.nulos_count || 0), 0);
    const chips = [];
    const chip = (label, val, color) => `<div style="flex:1 1 140px;min-width:120px;background:var(--zn-50);border:1px solid var(--zn-200);border-radius:10px;padding:8px 10px"><div style="font-size:10px;color:var(--zn-400);text-transform:uppercase;letter-spacing:.04em">${label}</div><div style="font-size:15px;font-weight:700;color:${color}">${val}</div></div>`;
    chips.push(chip("Columnas", String(cols.length), "var(--zp-600)"));
    chips.push(chip("Numéricas (analizables)", String(numCols), "#059669"));
    chips.push(chip("Con valores vacíos", String(conVacios.length), conVacios.length ? "#D97706" : "#16A34A"));
    chips.push(chip("Identificadores", String(ids.length), "var(--zn-700)"));
    chips.push(chip("Celdas vacías totales", String(totalVacios), totalVacios ? "#D97706" : "#16A34A"));
    resumen.innerHTML = chips.join("");
}

// ─── P-14 · 09/09: estadística orientada al negocio (margen % + ticket) ───
// Enfoque de negocio: media/mediana/desv del margen % mensual y ticket
// promedio (verificando el caso atípico vs el rango normal de cada métrica).
function renderizarStatsNegocio(biz) {
    const wrap = document.getElementById("wrap-stats-negocio");
    const tabla = document.getElementById("stats-negocio-tabla");
    if (!wrap || !tabla) return;
    const tml = ((biz && biz.tabla_mensual) || {}).filas || [];
    const margenes = tml.map(f => f.margen_pct).filter(v => v !== null && v !== undefined);
    const ticket = biz && biz.ticket_promedio;
    if (!margenes.length && ticket == null) { wrap.classList.add("d-none"); return; }
    wrap.classList.remove("d-none");
    // — Margen %: media, mediana, desv estándar, min, max —
    const n = margenes.length;
    let filasHtml = "";
    if (n >= 2) {
        const vals = margenes.map(Number).sort((a, b) => a - b);
        const media = vals.reduce((s, v) => s + v, 0) / n;
        const mediana = n % 2 ? vals[(n - 1) / 2] : (vals[n / 2 - 1] + vals[n / 2]) / 2;
        const varianza = vals.reduce((s, v) => s + (v - media) * (v - media), 0) / n;
        const desv = Math.sqrt(varianza);
        const min = Math.min(...vals), max = Math.max(...vals);
        const fila = (label, val) => `<tr><td style="text-align:left;color:var(--zn-600)">${label}</td><td style="text-align:right;font-weight:600">${val}</td></tr>`;
        filasHtml = fila("Media de margen % mensual", media.toFixed(1) + "%") +
                    fila("Mediana", mediana.toFixed(1) + "%") +
                    fila("Desviación estándar", "±" + desv.toFixed(1) + "pp") +
                    fila("Mínimo", min.toFixed(1) + "%") +
                    fila("Máximo", max.toFixed(1) + "%") +
                    fila("Meses analizados", String(n));
        // Contexto: caso atípico si el último mes está fuera de media ± 1 desv.
        const ult = margenes[margenes.length - 1];
        const ctx = document.getElementById("stats-negocio-contexto");
        if (ctx && n >= 3 && desv > 0) {
            const delta = Number(ult) - media;
            const fuera = Math.abs(delta) > desv;
            ctx.innerHTML = fuera
                ? `⚠️ El margen % del último mes (${Number(ult).toFixed(1)}%) está <b>fuera del rango normal</b> (media ${media.toFixed(1)}% ± ${desv.toFixed(1)}pp) — caso atípico, revisa la causa.`
                : `✅ El margen % del último mes (${Number(ult).toFixed(1)}%) está dentro del rango normal (media ${media.toFixed(1)}% ± ${desv.toFixed(1)}pp).`;
        } else if (ctx) {
            ctx.innerHTML = "Con menos de 3 meses la desviación no es concluyente.";
        }
    } else {
        filasHtml = "<tr><td class='text-muted'>Se necesitan al menos 2 meses con margen %.</td></tr>";
    }
    tabla.innerHTML = filasHtml;
    // — Ticket promedio —
    if (ticket != null) {
        const tp = document.getElementById("stats-ticket-general");
        if (tp) tp.textContent = formatearMoneda(ticket);
        const nOps = biz && biz.n_operaciones;
        const ops = document.getElementById("stats-ticket-ops");
        if (ops) ops.textContent = nOps != null ? String(nOps) : "—";
    }
}

// ─── Fase O-6: ficha de contexto del dataset (§2.5) ─────────────────────────
// Puebla la card de metadatos con la respuesta de /api/tabla/<id> (archivo,
// empresa, hoja, fecha) + lo calculado por el motor (filas, columnas, Eje Y).
function renderizarFichaContexto(meta, data) {
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.textContent = v || "—";
    };
    const perfil = (data && data.perfil_columnas) || {};
    const primera = Object.values(perfil)[0] || {};
    set("ficha-dataset",   (data && data.nombre) || meta.nombre || "");
    set("ficha-empresa",   meta.nombre_empresa);
    set("ficha-archivo",   meta.archivo);
    set("ficha-hoja",      meta.nombre_hoja);
    set("ficha-fecha",     meta.fecha);
    set("ficha-filas",     primera.total_filas !== undefined && primera.total_filas !== null ? formatearNum(primera.total_filas, 0) : "");
    set("ficha-columnas",  String(Object.keys(perfil).length || 0));
    set("ficha-columna-y", (data && data.kpis && data.kpis.columna) || _ejeYActual || "");
    const card = document.getElementById("ficha-contexto");
    if (card) card.classList.remove("d-none");
}

// ═══════════════════════════════════════════════════════════════════════════════
// [R-3b] DRAWER DE PERSONALIZACIÓN
// Lógica del panel lateral para personalizar colores, gráficos y categorías.
// ═══════════════════════════════════════════════════════════════════════════════

function abrirDrawerPersonalizar() {
    const overlay = document.getElementById("drawer-overlay");
    const drawer = document.getElementById("drawer-personalizar");
    if (!overlay || !drawer) return;
    const config = _configActual || {};
    _drawerColorPrincipal = config.color_principal || "#5B0672";
    _drawerMostrarMargen = config.mostrar_margen !== undefined ? config.mostrar_margen : true;
    const colorInput = document.getElementById("drawer-color-principal");
    const colorHex = document.getElementById("drawer-color-valor");
    if (colorInput) colorInput.value = _drawerColorPrincipal;
    if (colorHex) colorHex.textContent = _drawerColorPrincipal;
    const swMargen = document.getElementById("switch-margen");
    if (swMargen) swMargen.classList.toggle("on", _drawerMostrarMargen);
    cargarCategoriasDrawer();
    overlay.classList.add("open");
    drawer.classList.add("open");
}

function cerrarDrawerPersonalizar() {
    const overlay = document.getElementById("drawer-overlay");
    const drawer = document.getElementById("drawer-personalizar");
    if (overlay) overlay.classList.remove("open");
    if (drawer) drawer.classList.remove("open");
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRAWER DE FILTROS
// Lógica del panel lateral para filtrar datos por período, fecha y categoría.
// ═══════════════════════════════════════════════════════════════════════════════

function abrirDrawerFiltros() {
    const overlay = document.getElementById("drawer-filtros-overlay");
    const drawer = document.getElementById("drawer-filtros");
    if (!overlay || !drawer) return;
    // Cargar valores actuales de los filtros
    const selMes = document.getElementById("filtro-mes");
    const selTipo = document.getElementById("filtro-tipo");
    const selFechaDesde = document.getElementById("filtro-fecha-desde");
    const selFechaHasta = document.getElementById("filtro-fecha-hasta");
    if (selMes) selMes.value = _filtroMesActual || "";
    if (selTipo) selTipo.value = _filtroTipoActual || "";
    if (selFechaDesde) selFechaDesde.value = _filtroFechaDesde || "";
    if (selFechaHasta) selFechaHasta.value = _filtroFechaHasta || "";
    // Cargar opciones de mes si está vacío
    cargarOpcionesMesDrawer();
    overlay.style.display = "block";
    drawer.style.right = "0";
}

function cerrarDrawerFiltros() {
    const overlay = document.getElementById("drawer-filtros-overlay");
    const drawer = document.getElementById("drawer-filtros");
    if (overlay) overlay.style.display = "none";
    if (drawer) drawer.style.right = "-400px";
}

function cargarOpcionesMesDrawer() {
    const selMes = document.getElementById("filtro-mes");
    if (!selMes || selMes.options.length > 1) return;
    // Obtener meses únicos de los datos actuales
    const biz = window.__zenit_analytics || {};
    const tablaMensual = biz.business ? biz.business.tabla_mensual : null;
    const filas = tablaMensual ? tablaMensual.filas : [];
    const mesesUnicos = new Set();
    filas.forEach(f => {
        if (f.mes) mesesUnicos.add(f.mes);
    });
    // Agregar opciones de mes
    mesesUnicos.forEach(mes => {
        const opt = document.createElement("option");
        opt.value = mes;
        opt.textContent = mes;
        selMes.appendChild(opt);
    });
}

function aplicarFiltroMes(value) {
    _filtroMesActual = value || null;
    sessionStorage.setItem("zenit_filtro_mes", value || "");
}

function aplicarFiltroTipo(value) {
    _filtroTipoActual = value || null;
    sessionStorage.setItem("zenit_filtro_tipo", value || "");
}

function aplicarFiltroFechaDesde(value) {
    _filtroFechaDesde = value || null;
    sessionStorage.setItem("zenit_fecha_desde", value || "");
}

function aplicarFiltroFechaHasta(value) {
    _filtroFechaHasta = value || null;
    sessionStorage.setItem("zenit_fecha_hasta", value || "");
}

function filtrarCategoriasFiltro() {
    const input = document.getElementById("filtro-buscar-cat");
    const lista = document.getElementById("filtro-lista-categorias");
    if (!input || !lista) return;
    const busqueda = input.value.toLowerCase().trim();
    // Obtener categorías de los datos actuales
    const biz = window.__zenit_analytics || {};
    const resumenCategorias = biz.resumen_categorias || [];
    const categorias = resumenCategorias.map(c => c.categoria).filter(Boolean);
    // Filtrar por búsqueda
    const categoriasFiltradas = categorias.filter(cat =>
        cat.toLowerCase().includes(busqueda)
    );
    // Renderizar lista
    if (categoriasFiltradas.length === 0) {
        lista.innerHTML = '<p class="drawer-hint">No se encontraron categorías.</p>';
        return;
    }
    let html = "";
    categoriasFiltradas.forEach(cat => {
        const activo = !_categoriasExcluidas || !_categoriasExcluidas.includes(cat);
        html += `<label class="drawer-toggle-row" style="margin-bottom:6px">
            <span class="drawer-label" style="text-transform:none;font-weight:400">${cat}</span>
            <input type="checkbox" ${activo ? "checked" : ""} onchange="toggleCategoriaFiltro('${cat}', this.checked)">
        </label>`;
    });
    lista.innerHTML = html;
}

function toggleCategoriaFiltro(categoria, activo) {
    if (!_categoriasExcluidas) _categoriasExcluidas = [];
    if (activo) {
        _categoriasExcluidas = _categoriasExcluidas.filter(c => c !== categoria);
    } else {
        if (!_categoriasExcluidas.includes(categoria)) _categoriasExcluidas.push(categoria);
    }
}

function limpiarTodosFiltros() {
    _filtroMesActual = null;
    _filtroTipoActual = null;
    _filtroFechaDesde = null;
    _filtroFechaHasta = null;
    _categoriasExcluidas = [];
    sessionStorage.removeItem("zenit_filtro_mes");
    sessionStorage.removeItem("zenit_filtro_tipo");
    sessionStorage.removeItem("zenit_fecha_desde");
    sessionStorage.removeItem("zenit_fecha_hasta");
    // Limpiar selects
    const selMes = document.getElementById("filtro-mes");
    const selTipo = document.getElementById("filtro-tipo");
    const selFechaDesde = document.getElementById("filtro-fecha-desde");
    const selFechaHasta = document.getElementById("filtro-fecha-hasta");
    if (selMes) selMes.value = "";
    if (selTipo) selTipo.value = "";
    if (selFechaDesde) selFechaDesde.value = "";
    if (selFechaHasta) selFechaHasta.value = "";
}

function aplicarFiltros() {
    cerrarDrawerFiltros();
    cargarDashboard(currentTablaId);
}

// [31/08] El drawer centraliza los 3 NIVELES de personalización:
//   💰 Series (__ingresos/__egresos): color + switch global
//   🏷 Categorías (valores de columna_x): color INDIVIDUAL (pinta donas/
//      barras/Pareto vía obtenerPaletaColores) + switch (excluye al recargar)
//   🗂 Columnas del dataset (matriz): switch que oculta módulos dependientes
// Todo persiste con el MISMO motor de "Columnas del Dataset" + "Filtrar
// valores": modulos_visibles + colores_categoria/color_por_serie.
let _drawerSeries = [];
let _drawerColumnas = [];
// [T-1b · 31/08] Grupos del dataset (acordeones): array de
// {col: nombreColumna, valores: [ {id, nombre, monto, activo, color} ]}.
// `_drawerCategorias` es el aplanado de TODOS los valores (persistencia/toggle).
let _drawerGrupos = [];

function cargarCategoriasDrawer() {
    // ── 💰 Series principales (replica renderizarSeriesGlobales) ──
    _drawerSeries = [
        { id: "__ingresos", nombre: "💰 Ingresos", def: "#16A34A" },
        { id: "__egresos", nombre: "💸 Egresos", def: "#DC2626" },
    ].map(s => ({
        id: s.id, nombre: s.nombre, tipoLista: "serie",
        color: _coloresCategoriaActual[s.id] || s.def,
        activo: _modulosVisiblesActual[s.id] !== false,
    }));

    // ── 🗂 Columnas del dataset (perfil completo del bloque) ──
    const perfil = _perfilColumnasActual || {};
    _drawerColumnas = Object.keys(perfil).map(colRaw => {
        const col = String(colRaw);
        return {
            id: col, nombre: col, tipoLista: "col",
            tipo: (perfil[col] && perfil[col].tipo) || "",
            activo: _modulosVisiblesActual["col:" + col] !== false,
            color: colorColumna(col) || _colorDefectoEstable(col) || "#5B0672",
        };
    });

    // ── 🏷 GRUPOS del dataset (acordeones por columna de agrupación) ──
    // Fuente: analytics.resumen_por_columna = {columna: [{categoria, total}]}
    // (todas las columnas texto con cardinalidad ≤ 100). Fallback: la columna
    // categoría principal (resumen_categorias) para bloques sin el campo nuevo.
    const analytics = window.__zenit_analytics || {};
    let gruposSrc = analytics.resumen_por_columna || {};
    if (!Object.keys(gruposSrc).length && (analytics.resumen_categorias || []).length) {
        gruposSrc = { "Categorías": analytics.resumen_categorias };
    }
    _drawerCategorias = [];
    _drawerGrupos = [];
    Object.entries(gruposSrc).forEach(([col, items]) => {
        const valores = (items || []).map(c => ({
            id: String(c.categoria), nombre: String(c.categoria), tipoLista: "cat",
            monto: c.total || 0,
            activo: _modulosVisiblesActual[String(c.categoria)] !== false,
            color: _coloresCategoriaActual[String(c.categoria)] || _colorDefectoEstable(String(c.categoria)),
        }));
        if (valores.length) {
            _drawerGrupos.push({ col: col, valores });
            _drawerCategorias.push(...valores);
        }
    });
    // Sin grupos detectados → un solo grupo plano con lo que haya.
    if (!_drawerGrupos.length && _drawerCategorias.length) {
        _drawerGrupos = [{ col: "Valores", valores: _drawerCategorias }];
    }

    _drawerCategoriasOriginal = JSON.parse(JSON.stringify({
        series: _drawerSeries, columnas: _drawerColumnas, categorias: _drawerCategorias,
    }));
    renderizarSeriesDrawer();
    renderizarCategoriasDrawer();
    renderizarColumnasDrawer();
    sincronizarEjeYDrawer();
}

function _iconoTipoColumna(tipo) {
    return tipo === "numerico" ? "#" : (tipo === "fecha" ? "📅" : "🏷");
}

// Fila estándar: dot de color clickeable (input color swatch) + texto + switch
function _filaDrawerHtml(item, nombreHtml) {
    return '<div class="drawer-cat-row">' +
        '<div class="drawer-cat-left">' +
            '<input type="color" class="drawer-cat-dot" value="' + item.color + '" title="Color de ' + item.nombre + '" onchange="cambiarColorItemDrawer(\'' + item.tipoLista + '\', \'' + item.id.replace(/'/g, "\\'") + '\', this.value)">' +
            '<span class="drawer-cat-name ' + (item.activo ? '' : 'off') + '">' + nombreHtml + '</span>' +
        '</div>' +
        '<span class="drawer-switch ' + (item.activo ? 'on' : '') + '" onclick="toggleItemDrawer(\'' + item.tipoLista + '\', \'' + item.id.replace(/'/g, "\\'") + '\')"><span class="drawer-knob"></span></span>' +
    '</div>';
}

function renderizarSeriesDrawer() {
    const lista = document.getElementById("drawer-lista-series");
    if (!lista) return;
    lista.innerHTML = _drawerSeries.map(s => _filaDrawerHtml(s, s.nombre)).join("");
}

// [T-1b] ACORDEONES del drawer: un botón por columna de agrupación
// que al presionarse despliega sus valores (color individual + switch).
// Colapsados por defecto; primer grupo abierto si hay pocos o hay búsqueda.
const _acordeonesAbiertos = new Set();
function renderizarAcordeones(filtro = "") {
    const lista = document.getElementById("drawer-acordeones");
    if (!lista) return;
    const f = (filtro || "").toLowerCase().trim();
    const grupos = _drawerGrupos.map(g => ({
        col: g.col,
        valores: f
            ? g.valores.filter(v => v.nombre.toLowerCase().includes(f))
            : g.valores,
    })).filter(g => g.valores.length);
    if (!grupos.length) {
        lista.innerHTML = '<p class="drawer-hint" style="padding:8px 0">No se encontraron grupos o valores.</p>';
        return;
    }
    lista.innerHTML = grupos.map(g => {
        const abierto = f || _acordeonesAbiertos.has(g.col) || (!_acordeonesAbiertos.size && _drawerGrupos.length === 1);
        return '<div class="drawer-acordeon" style="margin-bottom:4px">' +
            '<div class="drawer-acordeon-header" onclick="toggleAcordeonDrawer(this)">' +
                '<span class="drawer-acordeon-tri">' + (abierto ? "▾" : "▸") + '</span>' +
                '<span class="drawer-acordeon-titulo">' + g.col.replace(/"/g, "&quot;") + '</span>' +
                '<span class="drawer-acordeon-count">' + g.valores.length + '</span>' +
            '</div>' +
            '<div class="drawer-acordeon-body" ' + (abierto ? '' : 'style="display:none"') + '>' +
                g.valores.map(v => _filaDrawerHtml(v,
                    v.nombre.replace(/"/g, "&quot;") + '<span class="drawer-cat-amount">$' + formatearNum(v.monto) + '</span>')).join("") +
            '</div>' +
        '</div>';
    }).join("");
}
function toggleAcordeonDrawer(header) {
    const body = header && header.nextElementSibling;
    if (!body) return;
    const abierto = body.style.display !== "none";
    body.style.display = abierto ? "none" : "";
    const tri = header.querySelector(".drawer-acordeon-tri");
    if (tri) tri.textContent = abierto ? "▸" : "▾";
    const titulo = header.querySelector(".drawer-acordeon-titulo");
    if (titulo) {
        if (abierto) _acordeonesAbiertos.delete(titulo.textContent);
        else _acordeonesAbiertos.add(titulo.textContent);
    }
}
// Alias retrocompat (cargarCategoriasDrawer/refrescar lo llaman):
function renderizarCategoriasDrawer(filtro) { renderizarAcordeones(filtro); }

function renderizarColumnasDrawer(filtro = "") {
    const lista = document.getElementById("drawer-lista-columnas");
    if (!lista) return;
    const f = (filtro || "").toLowerCase().trim();
    const cols = f ? _drawerColumnas.filter(c => c.nombre.toLowerCase().includes(f)) : _drawerColumnas;
    if (cols.length === 0) {
        lista.innerHTML = '<p class="drawer-hint" style="padding:8px 0">No se encontraron columnas.</p>';
        return;
    }
    lista.innerHTML = cols.map(c => _filaDrawerHtml(c, _iconoTipoColumna(c.tipo) + " " + c.nombre)).join("");
}

// Toggles por (tipoLista, id): series/categorías/columnas comparten mecanismo
function _listaPorTipo(tipo) {
    return tipo === "serie" ? _drawerSeries : (tipo === "col" ? _drawerColumnas : _drawerCategorias);
}
function toggleItemDrawer(tipo, id) {
    const it = _listaPorTipo(tipo).find(x => x.id === id);
    if (it) { it.activo = !it.activo; refrescarListasDrawer(); }
}
function cambiarColorItemDrawer(tipo, id, colorHex) {
    const it = _listaPorTipo(tipo).find(x => x.id === id);
    if (it) { it.color = colorHex; refrescarListasDrawer(); }
}
function toggleCategoriaDrawer(tipo, id) { toggleItemDrawer(tipo, id); }  // retrocompat
function cambiarColorColumnaDrawer(tipo, id, colorHex) { cambiarColorItemDrawer(tipo, id, colorHex); }

// [T-1b] El input principal filtra GRUPOS (acordeones); las columnas tienen
// su propio input (#drawer-buscar-cat2 vía filtrarColumnasDrawer2).
function filtrarCategoriasDrawer() {
    const input = document.getElementById("drawer-buscar-cat");
    const f = input ? input.value : "";
    renderizarAcordeones(f);
}
function filtrarColumnasDrawer2(v) {
    renderizarColumnasDrawer(v || "");
}
function refrescarListasDrawer() {
    const input = document.getElementById("drawer-buscar-cat");
    const f = input ? input.value : "";
    const inp2 = document.getElementById("drawer-buscar-cat2");
    const f2 = inp2 ? inp2.value : "";
    renderizarSeriesDrawer();
    renderizarAcordeones(f);
    renderizarColumnasDrawer(f2);
}

function toggleCategoriasDrawer(state) {
    [_drawerSeries, _drawerColumnas, _drawerCategorias].forEach(lista => {
        lista.forEach(c => { c.activo = state; });
    });
    refrescarListasDrawer();
}

function refrescarListasDrawer() {
    const input = document.getElementById("drawer-buscar-cat");
    const f = input ? input.value : "";
    renderizarSeriesDrawer();
    renderizarCategoriasDrawer(f);
    renderizarColumnasDrawer(f);
}

// [31/08] Sincroniza la sección "🎯 Métrica actual (Eje Y)" del drawer con la
// columna Y resuelta (misma lógica que la fila destacada del panel viejo).
function sincronizarEjeYDrawer() {
    const nombreEl = document.getElementById("drawer-eje-y-nombre");
    const colorEl = document.getElementById("drawer-color-eje-y");
    const ejeY = _ejeYActual || "";
    if (nombreEl) nombreEl.textContent = ejeY || "—";
    if (colorEl && ejeY) colorEl.value = colorColumna(ejeY) || _colorDefectoEstable(ejeY);
}
function cambiarColorEjeYDrawer(colorHex) {
    if (_ejeYActual) { cambiarColorColumna(_ejeYActual, colorHex); return; }
    _drawerColorPrincipal = colorHex;  // fallback: sin eje Y, actualiza principal
}

function aplicarColorPrincipal(color) {
    _drawerColorPrincipal = color;
    const colorHex = document.getElementById("drawer-color-valor");
    if (colorHex) colorHex.textContent = color;
}

function toggleMargen() {
    _drawerMostrarMargen = !_drawerMostrarMargen;
    const sw = document.getElementById("switch-margen");
    if (sw) sw.classList.toggle("on", _drawerMostrarMargen);
}

async function aplicarPersonalizacion() {
    if (!currentTablaId) { alert("No hay un dataset activo."); return; }
    // [31/08] Persistir los 3 niveles con el MISMO motor real:
    //  · modulos_visibles: col:X (columnas), __ingresos/__egresos (series)
    //    y NOMBRE de categoría (false = excluir al recargar, §6.1)
    //  · colores_categoria + color_por_serie: color individual por valor,
    //    por serie y por columna (R22 — mismo hex en pantalla y PDF).
    const modulosVisibles = Object.assign({}, _modulosVisiblesActual || {});
    const colores = Object.assign({}, _coloresCategoriaActual || {});
    _drawerSeries.forEach(s => {
        modulosVisibles[s.id] = s.activo;
        colores[s.id] = s.color;
    });
    _drawerColumnas.forEach(c => {
        modulosVisibles["col:" + c.id] = c.activo;
        const sk = _serieKeyDeNombre(c.id);
        if (sk) { colores[sk] = c.color; delete colores["col:" + c.id]; }
        else { colores[c.id] = c.color; delete colores["col:" + c.id]; }
    });
    _drawerCategorias.forEach(c => {
        modulosVisibles[c.id] = c.activo;
        if (!_esValorTipoFinanciero(c.id)) colores[c.id] = c.color;
    });
    const configBloque = {
        color_principal: _drawerColorPrincipal,
        color_personalizado: true,
        mostrar_margen: _drawerMostrarMargen,
        color_por_serie: colores,
    };
    try {
        await Promise.all([
            fetch("/api/tabla/" + currentTablaId + "/config", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ modulos_visibles: modulosVisibles, colores_categoria: colores }),
            }),
            fetch("/api/bloque/" + currentTablaId + "/config", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(configBloque),
            }),
        ]);
        _modulosVisiblesActual = modulosVisibles;
        _coloresCategoriaActual = colores;
        _configActual = { ...(_configActual || {}), color_principal: _drawerColorPrincipal, mostrar_margen: _drawerMostrarMargen };
        cerrarDrawerPersonalizar();
        // Recargar el dashboard con el flujo real: aplicar excluye categorías/
        // series apagadas (§6.1) y los colores viajan a donas/barras/Pareto.
        if (typeof cargarDashboard === "function") cargarDashboard(currentTablaId);
    } catch (err) {
        console.error("Error:", err);
        alert("Error de conexión al guardar.");
    }
}
