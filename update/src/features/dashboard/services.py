"""
Servicio de orquestación del motor analítico genérico (Plan E v3.3.0, TAREA 6).
Punto de entrada único: obtener_analytics().

[v3.3.0] Cambios de fondo respecto a v2.1.0:
  1. _cargar_dataframe_bloque() usa leer_parquet() canónica (Plan 0 v4.1.0).
  2. El EDA se delega en src/features/dashboard/eda_jobs.py, que despacha
     generar_reporte_eda_desde_parquet() de Plan D por el pool compartido
     (src/shared/lib/task_executor.py, TAREA 1 Plan E) — el módulo viejo
     del EDA fue retirado a deprecated/ (TAREA 0, ver Plan E v3.3.0).
  3. obtener_analytics() retorna tipo_bloque, tendencia (para
     detalle/lista_entidad) y valor_destacado (para resumen_totales), según
     el despacho por tipo de bloque (Fundacional §6.2).
"""
import json
import logging
import re
import pandas as pd

from src.shared.api.db import db
from src.shared.lib.crypto_utils import leer_parquet
from src.entities.bloque import CoreBloque
from src.features.dashboard.analytics import profiler, generic_engine, rankings
from src.features.dashboard.analytics.verticals import financiero as _financiero
from src.features.dashboard.analytics.verticals import activos_fijos as _activos_fijos
from src.features.dashboard.analytics.narrative import generar_narrativa
from src.features.dashboard.analytics.plantillas import sugerir_plantilla
from src.features.dashboard.eda_jobs import obtener_reporte_eda as obtener_reporte_eda_async

logger = logging.getLogger(__name__)

TIPOS_BLOQUE_VALIDOS = {"detalle", "resumen_totales", "lista_entidad", "otro"}


def _cargar_dataframe_bloque(bloque: "CoreBloque") -> pd.DataFrame:
    """Lee el Parquet del bloque. [v9.0.0] Sin cifrado (§8.1)."""
    if not bloque.parquet_path:
        raise FileNotFoundError(
            f"El bloque '{bloque.id}' no tiene datos asociados. Vuelve a importar el archivo Excel."
        )

    return leer_parquet(bloque.parquet_path)


def _decimal_places_bloque(bloque: "CoreBloque") -> int:
    """Precisión del bloque — el redondeo ocurre en el backend (§5.8/§5.9)."""
    return getattr(bloque, "decimal_places", None) or 2


def _margen_exclusiones_de_config(bloque: "CoreBloque") -> list[str]:
    """
    [A1-H1] Conceptos genéricos a excluir en Margen por Entidad, leídos desde
    `config.margen_entidad.exclusiones` del bloque (lista de strings).
    Default seguro: [] (no excluir nada). Config corrupto → [] con warning.
    """
    try:
        cfg = json.loads(bloque.config) if getattr(bloque, "config", None) else {}
        datos = (cfg.get("margen_entidad") or {}).get("exclusiones") or []
        return [str(x) for x in datos] if isinstance(datos, list) else []
    except (json.JSONDecodeError, TypeError):
        logger.warning(
            "Config corrupto leyendo margen_entidad (bloque=%s)",
            getattr(bloque, "id", "?"),
        )
        return []


def _calcular_resumen_categorias(df: pd.DataFrame) -> list[dict]:
    """
    [R-3b] Resumen por categoría para el drawer de personalización.

    Agrupa la columna de categoría (detectada con la MISMA heurística central
    `_detectar_columna_categoria`) contra la columna de monto, y devuelve una
    lista serializable [{categoria, total}] ordenada descendente por total.

    Sin columna de categoría o sin datos → [] (el drawer muestra aviso vacío).
    Vectorizado (groupby, nunca iterar filas). Todos los valores a primitivos.
    """
    col_cat = _detectar_columna_categoria(df) or _encontrar_columna(df, "categoria")
    col_monto = _encontrar_columna(df, "monto")
    if not col_cat or col_cat not in df.columns or not col_monto or col_monto not in df.columns:
        return []
    monto_num = pd.to_numeric(df[col_monto], errors="coerce")
    agg = (
        pd.DataFrame({"cat": generic_engine.etiqueta_dimension(df[col_cat]), "m": monto_num})
        .dropna()
        .groupby("cat")["m"]
        .sum()
        .sort_values(ascending=False)
    )
    return [{"categoria": str(k), "total": float(v)} for k, v in agg.items()]


# Límite de valores únicos por columna para que sea "agrupable" en el drawer
# (más de esto = identificador/ruido; el profiler ya marca es_identificador).
_MAX_CARDINALIDAD_GRUPO = 100


def _calcular_resumen_por_columna(
    df: pd.DataFrame,
    perfil_columnas: dict,
    col_monto: str | None = None,
) -> dict:
    """
    [T-1b · 31/08] Resumen de valores POR CADA columna de agrupación del
    Excel (nivel "detallado" del drawer): {columna: [{categoria, total}...]}.

    Solo columnas tipo "texto" con cardinalidad ≤ 100 y que no sean
    identificadores (R23). Excluye la columna de monto (numérica) y fechas.
    Vectorizado (groupby por columna). Monto = suma de la columna de monto
    del análisis; sin monto → conteo de filas por valor.

    Args:
        df: DataFrame del bloque (ya filtrado por el filtro global).
        perfil_columnas: perfil del bloque (perfil_columnas de obtener_analytics).
        col_monto: columna de monto del análisis (opcional; si no, heurística).

    Returns:
        dict: {nombre_columna: [{"categoria": valor, "total": monto_o_conteo}]},
        ordenado descendente por total. {} si no hay columnas agrupables.
    """
    if not col_monto or col_monto not in df.columns:
        col_monto = _encontrar_columna(df, "monto")
    monto_num = (
        pd.to_numeric(df[col_monto], errors="coerce")
        if col_monto and col_monto in df.columns
        else None
    )
    resultado: dict = {}
    for col_raw, perfil in (perfil_columnas or {}).items():
        col = str(col_raw)
        if not col or col not in df.columns or col == col_monto:
            continue
        if (perfil or {}).get("tipo") != "texto":
            continue  # solo texto (fechas/números no agrupan por valor)
        if (perfil or {}).get("es_identificador"):
            continue
        if int((perfil or {}).get("cardinalidad") or 0) > _MAX_CARDINALIDAD_GRUPO:
            continue
        serie = df[col]
        if monto_num is not None:
            agg = (
                pd.DataFrame({"v": generic_engine.etiqueta_dimension(serie), "m": monto_num})
                .dropna()
                .groupby("v")["m"]
                .sum()
                .sort_values(ascending=False)
            )
            resultado[col] = [
                {"categoria": str(k), "total": float(v)} for k, v in agg.items()
            ]
        else:
            agg = (
                generic_engine.etiqueta_dimension(serie)
                .dropna()
                .value_counts()
                .sort_values(ascending=False)
            )
            resultado[col] = [
                {"categoria": str(k), "total": float(v)} for k, v in agg.items()
            ]
    return resultado


# [Fase L-1 — "importa y ve"] Palabras que sugieren periodicidad; se evitan
# como Eje Y automático (un "mes"/"año" no es una métrica a sumar).
_PALABRAS_PERIODICIDAD_AUTO = ("año", "mes", "periodo", "período", "trimestre")


def _es_nombre_periodico(nombre: str) -> bool:
    n = (nombre or "").lower()
    return any(p in n for p in _PALABRAS_PERIODICIDAD_AUTO)


def _resolver_ejes_por_defecto(
    bloque: "CoreBloque",
    perfil_columnas: dict,
    columna_x: str = None,
    columna_y: str = None,
    df: pd.DataFrame = None,
) -> tuple[str | None, str | None]:
    """
    [Fase L-1 — "importa y ve"] Resuelve automáticamente los ejes cuando el
    llamador no los especifica:

      Eje Y: bloque.col_monto si existe y no es identificador (regla R23); en
             su defecto, la primera columna numérica sumable que no sea
             identificador ni sugiera periodicidad (año/mes/periodo/trimestre).
      Eje X: bloque.col_categoria → bloque.col_fecha → primera columna de tipo
             texto/fecha distinta del eje Y.

    Devuelve (columna_x, columna_y) tal cual deben usarse. (None, None) si no
    hay ninguna columna sumable — el llamador muestra el placeholder
    informativo en ese caso.
    """
    if columna_y:
        # Ejes explícitos del llamador: nunca se tocan
        return columna_x, columna_y

    orden = list(perfil_columnas.keys())

    # ── Eje Y ──
    eje_y: str | None = None
    monto = getattr(bloque, "col_monto", None)
    perfil_monto = perfil_columnas.get(monto) if monto else None
    if perfil_monto and not perfil_monto.get("es_identificador"):
        eje_y = monto
    else:
        for c in orden:
            p = perfil_columnas[c]
            if (p.get("tipo") == "numerico"
                    and not p.get("es_identificador")
                    and not _es_nombre_periodico(c)):
                eje_y = c
                break

    # [L-4b] Sin columnas numéricas puras (dtype): probar coercibilidad.
    # Bloques con fila de sub-encabezado y etiquetas intercaladas (ej.
    # "MARGEN POR PROCEDIMIENTO") llegan como object dtype con números dentro.
    # Estrategia "mejor esfuerzo": elegir la columna con MAYOR ratio de
    # coercibilidad (≥ 0.50 y al menos 3 valores numéricos). Calcular_kpis
    # aplica pd.to_numeric, así que los textos de etiqueta se omiten del total.
    if eje_y is None and df is not None:
        mejor_ratio = 0.0
        mejor_col: str | None = None
        for c in orden:
            if _es_nombre_periodico(c):
                continue
            serie_try = pd.to_numeric(df[c], errors="coerce").dropna()
            total_try = df[c].dropna()
            if len(total_try) == 0 or len(serie_try) < 3:
                continue
            ratio = len(serie_try) / len(total_try)
            if ratio > mejor_ratio:
                mejor_ratio = ratio
                mejor_col = c
        if mejor_col is not None and mejor_ratio > 0.50:
            eje_y = mejor_col

    # ── Eje X ──
    eje_x: str | None = None
    if eje_y is not None:
        for c in (getattr(bloque, "col_categoria", None), getattr(bloque, "col_fecha", None)):
            if c and c in perfil_columnas and c != eje_y:
                eje_x = c
                break
        if eje_x is None:
            for c in orden:
                if c == eje_y:
                    continue
                if perfil_columnas[c].get("tipo") in ("texto", "fecha"):
                    eje_x = c
                    break

    return eje_x, eje_y


def _despachar_por_tipo_bloque(bloque: "CoreBloque") -> str:
    """Valida y devuelve tipo_bloque (Fundacional §6.2: detalle | resumen_totales | lista_entidad | otro)."""
    tipo_bloque = getattr(bloque, "tipo_bloque", None)
    if tipo_bloque not in TIPOS_BLOQUE_VALIDOS:
        logger.warning(
            "bloque_id=%s tiene tipo_bloque=%r fuera de los válidos %s",
            getattr(bloque, "id", "?"), tipo_bloque, sorted(TIPOS_BLOQUE_VALIDOS),
        )
        raise ValueError(
            f"El bloque tiene un tipo_bloque no reconocido: {tipo_bloque!r}. "
            f"Valores válidos: {sorted(TIPOS_BLOQUE_VALIDOS)}."
        )
    return tipo_bloque



def _calcular_margen_automatico(
    df: pd.DataFrame,
    columna_monto: str,
    columna_tipo: str,
) -> dict | None:
    """[L-3b] Margen automático Ingreso − Egreso.

    Detecta el patrón de forma UNIVERSAL (sin vocabulario de negocio asumido):
    existe una columna de tipo/clasificación con valores literales "ingreso(s)"
    y "egreso(s)". No requiere dominio financiero declarado.

    Args:
        df: DataFrame del bloque.
        columna_monto: nombre de la columna numérica a sumar (Eje Y resuelto).
        columna_tipo: columna cuyos valores indican ingreso/egreso (X o col_tipo).

    Returns:
        dict con ingresos/egresos/margen (tipos Python nativos) o None si no aplica.
    """
    if not columna_monto or not columna_tipo:
        return None
    if columna_monto not in df.columns or columna_tipo not in df.columns:
        return None

    monto = pd.to_numeric(df[columna_monto], errors="coerce")
    tipo = df[columna_tipo].astype(str).str.strip().str.lower()
    es_ingreso = tipo.isin(["ingreso", "ingresos"])
    es_egreso = tipo.isin(["egreso", "egresos"])
    # [Fase dedup · FIX] Serie PARCIAL: si el usuario apagó una serie desde el
    # panel (C-1 excluye ingreso/egreso), el df puede tener un solo lado.
    # Antes se anulaba TODO business (None) y desaparecían también las tarjetas/
    # donuts del lado VIVO. Ahora devolvemos parcial con flags para que el
    # frontend oculte únicamente lo que corresponde.
    tiene_i = bool(es_ingreso.any())
    tiene_e = bool(es_egreso.any())
    if not tiene_i and not tiene_e:
        return None

    ingresos = float(monto[es_ingreso].sum())
    egresos = float(monto[es_egreso].sum())
    return {
        "columna_tipo": columna_tipo,
        "columna_monto": columna_monto,
        "ingresos": round(ingresos, 2),
        "egresos": round(egresos, 2),
        "margen": float(ingresos - egresos),
        "n_ingresos": int(es_ingreso.sum()),
        "n_egresos": int(es_egreso.sum()),
        "falta_ingresos": not tiene_i,
        "falta_egresos": not tiene_e,
    }



def _encontrar_columna(df: pd.DataFrame, nombre_objetivo: str):
    """[Frente C · E1] Localiza una columna por nombre normalizado (sin tildes,
    case-insensitive). Devuelve el nombre real de la columna o None."""
    objetivo = nombre_objetivo.strip().lower()
    for c in df.columns:
        if str(c).strip().lower() == objetivo:
            return c
    return None


_MES_NUM = {
    "enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6,
    "julio": 7, "agosto": 8, "septiembre": 9, "octubre": 10, "noviembre": 11,
    "diciembre": 12,
}


_MES_POR_NUM = {v: k for k, v in _MES_NUM.items()}


def _fecha_parseable_en(df: pd.DataFrame, col: str, umbral: float = 0.5) -> bool:
    """
    [Resumen-vs · 28/08] True si la columna es datetime real, o si su nombre
    normalizado es "fecha" y al menos `umbral` de sus valores parsean como
    fecha (mismo espíritu que la coerción L-4b: >50%).
    """
    if col not in df.columns:
        return False
    if pd.api.types.is_datetime64_any_dtype(df[col]):
        return True
    if str(col).strip().lower() != "fecha":
        return False
    try:
        parseadas = pd.to_datetime(df[col], errors="coerce")
        return bool(parseadas.notna().mean() > umbral)
    except (ValueError, TypeError) as exc:
        logger.debug("Columna %r no parseable como fecha: %s", col, exc)
        return False


def _detectar_columna_calendario(
    bloque: "CoreBloque",
    df: pd.DataFrame,
    perfil_columnas: dict,
) -> tuple[str | None, bool]:
    """
    [Plan F · 23/08] Localiza la columna de calendario para las series
    temporales (Tendencia Mensual/Anual) y el rango de fechas.

    Prioridad (REVISADA 28/08 — comparativas "vs" del dueño, LISTA DEFINITIVA):
      1. Columna literal "Fecha" con datos parseables (dtype datetime o
         >50% parseable) → claves "YYYY-MM" y series anuales reales.
         IMPRESCINDIBLE para distinguir Enero-2025 de Enero-2026 y calcular
         "2025 vs 2026". La matriz de la clínica tiene Fecha + Mes.
      2. `bloque.col_fecha` (mapeada por el usuario en el wizard) si es
         parseable.
      3. Primera columna dtype datetime cuyo nombre contenga "fecha"/"date".
      4. Columna literal "Mes" (texto) → serie por nombre de mes (sin año),
         comportamiento previo (bloques sin fecha real, retrocompatible).
      5. Primera columna del perfil con tipo "fecha".
      6. Primera columna cuyo nombre contenga "fecha"/"date".

    Devuelve (columna, es_fecha). `es_fecha=True` indica que la columna se debe
    derivar con pd.to_datetime (zonas multi-año incluidas); `False` indica una
    columna de nombre de mes textual.
    """
    if df is None or df.empty:
        return None, False
    col_fecha_real = _encontrar_columna(df, "fecha")
    if col_fecha_real and _fecha_parseable_en(df, col_fecha_real):
        return col_fecha_real, True
    col_fecha_mapeada = getattr(bloque, "col_fecha", None)
    if (
        col_fecha_mapeada
        and col_fecha_mapeada in df.columns
        and _fecha_parseable_en(df, col_fecha_mapeada)
    ):
        return str(col_fecha_mapeada), True
    for c in df.columns:
        n = str(c).strip().lower()
        if ("fecha" in n or "date" in n) and pd.api.types.is_datetime64_any_dtype(df[c]):
            return str(c), True
    col_mes_txt = _encontrar_columna(df, "mes")
    if col_mes_txt:
        return col_mes_txt, False
    for c in df.columns:
        if (perfil_columnas or {}).get(str(c), {}).get("tipo") == "fecha":
            return str(c), True
    for c in df.columns:
        n = str(c).strip().lower()
        if "fecha" in n or "date" in n:
            return str(c), True
    return None, False


def _detectar_columna_categoria(
    df: pd.DataFrame,
    col_t: str | None = None,
    col_m: str | None = None,
) -> str | None:
    """
    [FIX 23/08] Detecta la columna de categoría financiera con la MISMA
    heurística que usa el resumen I/E (donuts/rankings). Reutilizada por el
    filtro C-1 para que 'Categorías visibles' filtre la MISMA columna que
    pintan los donuts — antes solo filtraba columna_x y si differía, el
    toggle no tenía ningún efecto visible.

    Heurística: columna llamada "categoria"/"concepto" (normalizado); en su
    defecto, la primera columna de texto con 2..60 valores únicos excluyendo
    fecha/mes/tipo/monto.
    """
    if df is None or df.empty:
        return None
    for cand in ("categoria", "concepto"):
        c = _encontrar_columna(df, cand)
        if c and c != col_t:
            return c
    for c in df.columns:
        cs = str(c).strip().lower()
        if col_t and c == col_t:
            continue
        if col_m and c == col_m:
            continue
        if cs in ("fecha", "mes"):
            continue
        try:
            if df[c].dtype == object and 1 < df[c].nunique() <= 60:
                return c
        except Exception as exc:
            # [DEBT-S112] Columna ilegible para la heurística: se salta sin crash.
            logger.debug("Columna %r descartada por heurística: %s", c, exc)
            continue
    return None


def _fechas_a_claves_rango(es_fecha: bool, fd: str | None, fh: str | None):
    """
    [Fase 4 · 23/08] Convierte fechas ISO (YYYY-MM-DD) del calendario a CLAVES
    de período comparables por _aplicar_rango_fechas/_construir_series:
      - columna Fecha real -> clave ISO de mes "YYYY-MM".
      - Mes textual -> nombre normalizado ("marzo"), ordinal vía _MES_NUM.
    Devuelve (clave_desde, clave_hasta); None donde no aplique.
    """

    def _mes_de(iso: str | None) -> int | None:
        if not iso:
            return None
        d = pd.to_datetime(iso, errors="coerce")
        return None if (d is pd.NaT or d is None) else int(d.month)

    if es_fecha:
        d0 = pd.to_datetime(fd, errors="coerce") if fd else pd.NaT
        d1 = pd.to_datetime(fh, errors="coerce") if fh else pd.NaT
        kd = d0.strftime("%Y-%m") if (d0 is not pd.NaT and d0 is not None) else None
        kh = d1.strftime("%Y-%m") if (d1 is not pd.NaT and d1 is not None) else None
        return kd, kh
    n0 = _MES_POR_NUM.get(_mes_de(fd)) if fd else None
    n1 = _MES_POR_NUM.get(_mes_de(fh)) if fh else None
    return n0, n1


def _aplicar_rango_fechas(
    df: pd.DataFrame,
    col_cal: str | None,
    es_fecha: bool,
    desde: str | None,
    hasta: str | None,
) -> tuple[pd.DataFrame, bool]:
    """
    [Frente C · E4-dinámico 23/08] Recorta el DataFrame al rango temporal
    [desde, hasta] dado por las claves de período:

      - columna de fecha (`es_fecha=True`): claves ISO "YYYY-MM", comparación
        cronológica por string (orden natural = cronológico, maneja multi-año).
      - columna de mes textual (`es_fecha=False`): comparación ordinal por
        `_MES_NUM` (preserva el cruce de año entre mes final e inicial).

    Devuelve (df_filtrado | df_original, aplicado_bool).
    """
    if not (col_cal and col_cal in df.columns):
        return df, False
    if not (desde or hasta):
        return df, False
    try:
        if es_fecha:
            per = pd.to_datetime(df[col_cal], errors="coerce").dt.to_period("M")
            valido = per.notna()
            if not bool(valido.any()):
                return df, False
            per_s = per[valido].astype(str)
            cl_desde = desde or str(per_s.min())
            cl_hasta = hasta or str(per_s.max())
            mask = valido & (per_s >= cl_desde) & (per_s <= cl_hasta)
        else:
            num_mes = df[col_cal].astype(str).str.strip().str.lower().map(_MES_NUM)
            num_desde = _MES_NUM.get((desde or "").strip().lower(), 1)
            num_hasta = _MES_NUM.get((hasta or "").strip().lower(), 12)
            if num_desde <= num_hasta:
                mask = num_mes.between(num_desde, num_hasta)
            else:
                mask = num_mes.isna() | num_mes.between(num_desde, 12) | num_mes.between(1, num_hasta)
        if bool(mask.any()):
            return df[mask], True
        return df, False
    except Exception as exc:
        logger.warning("Rango de fechas omitido (col=%r): %s", col_cal, exc, exc_info=True)
        return df, False


# ── [Resumen-vs · 28/08] Máscara de PERÍODO (comparativas "vs" del dueño) ────
_RE_CLAVE_MES = re.compile(r"^(\d{4})-(\d{1,2})$")
_RE_MES_ANIO = re.compile(r"^([a-záéíóúñ]+)[\s\-]+(\d{4})$")


def _mascara_periodo(
    df: pd.DataFrame,
    valor: str | None,
    col_cal: str | None,
    es_fecha: bool,
    col_mes: str | None = None,
) -> pd.Series | None:
    """
    Máscara booleana de un PERÍODO elegido por el usuario, aceptando los tres
    formatos que produce la app:
      - clave ISO del selector de períodos:  "2026-01"
      - label con año (multi-año):           "Enero 2026"
      - nombre simple (retrocompatible):     "enero"

    Estrategia según columnas disponibles:
      - formato CON año + calendario de fecha  → (año, mes) sobre la fecha.
      - formato CON año + solo "Mes" textual   → ordinal del mes (un nombre de
        mes textual no puede distinguir años; se compara solo el mes).
      - nombre simple + "Mes" textual          → igualdad textual (comportamiento
        previo EXACTO de obtener_analytics / obtener_registros).
      - nombre simple + solo calendario fecha  → ordinal del mes (cualquier año).

    Returns:
        Máscara booleana (índice = df.index) o None si el valor/columnas no
        permiten interpretar el filtro (el caller conserva su camino anterior).
    """
    if df is None or df.empty or not valor:
        return None
    v = str(valor).strip().lower()
    m_iso = _RE_CLAVE_MES.match(v)
    m_anio = _RE_MES_ANIO.match(v)
    col_f = col_cal if (es_fecha and col_cal and col_cal in df.columns) else None
    if m_iso or m_anio:
        anio = int(m_iso.group(1)) if m_iso else int(m_anio.group(2))
        mes = int(m_iso.group(2)) if m_iso else _MES_NUM.get(m_anio.group(1))
        if mes is None or not (1 <= mes <= 12):
            return None
        if col_f is not None:
            fechas = pd.to_datetime(df[col_f], errors="coerce")
            return fechas.dt.year.eq(anio) & fechas.dt.month.eq(mes)
        if col_mes and col_mes in df.columns:
            return (
                df[col_mes].astype(str).str.strip().str.lower().map(_MES_NUM).eq(mes)
            )
        return None
    # Nombre simple de mes ("enero")
    mes = _MES_NUM.get(v)
    if col_mes and col_mes in df.columns:
        return df[col_mes].astype(str).str.strip().str.lower().eq(v)
    if mes is not None and col_f is not None:
        fechas = pd.to_datetime(df[col_f], errors="coerce")
        return fechas.dt.month.eq(mes)
    return None


def _label_de_clave_mensual(clave: str) -> str:
    """[Resumen-vs · 28/08] "2026-01" → "Enero 2026" (labels de series ISO)."""
    m = _RE_CLAVE_MES.match(str(clave).strip())
    if not m:
        return str(clave).title()
    nombre = _MES_POR_NUM.get(int(m.group(2)), "")
    return f"{nombre.title()} {m.group(1)}" if nombre else str(clave).title()
def _construir_series_calendario(
    df_cal: pd.DataFrame,
    col_cal: str | None,
    es_fecha: bool,
    col_m: str,
    col_t: str,
    limite_desde: str | None = None,
    limite_hasta: str | None = None,
    bloque_id: int = 0,
    col_categoria: str | None = None,
) -> dict:
    """
    [Plan F · 23/08] Construye las series temporales (mensual y anual) de
    Ingresos/Egresos/Margen sobre el contexto calendario completo, acotado
    opcionalmente al rango [limite_desde, limite_hasta].

    - `es_fecha=False` (columna "Mes" textual): agrupa por nombre de mes, orden
      calendario `_MES_NUM`. Etiquetas "Marzo", "Abril"... La clave de período
      coincide con el nombre normalizado.
    - `es_fecha=True` (columna Fecha): deriva el mes con `pd.to_datetime`. Si
      los datos abarcan más de un año, las etiquetas llevan año ("Marzo 2026");
      si hay un solo año, quedan como "Marzo". La clave de período es "YYYY-MM"
      (orden cronológico por cadena).

    Devuelve dict con las 6 series ({labels, valores} o None), `periodos`
    (lista [{"clave", "label"}] cronológica para poblar selectores) y, si se
    pasa `col_categoria`, `_conteos_mensuales` ({"claves", "consultas",
    "cirugias"} alineados con las series — [PRIORIDAD 0] alimenta la tabla
    mensual del Resumen con las columnas Consultas/Cirugías).
    """
    vacio = {
        "_serie_mensual_ingresos": None,
        "_serie_mensual_egresos": None,
        "_serie_mensual_margen": None,
        "_serie_anual_ingresos": None,
        "_serie_anual_egresos": None,
        "_serie_anual_margen": None,
        "periodos": [],
        "_conteos_mensuales": None,
    }
    if df_cal is None or df_cal.empty:
        return vacio
    if col_m not in df_cal.columns or col_t not in df_cal.columns:
        return vacio
    if not (col_cal and col_cal in df_cal.columns):
        return vacio

    cal = df_cal
    if limite_desde or limite_hasta:
        cal, _ = _aplicar_rango_fechas(cal, col_cal, es_fecha, limite_desde, limite_hasta)
    if cal is None or cal.empty:
        return vacio

    monto = pd.to_numeric(cal[col_m], errors="coerce")
    tipo = cal[col_t].astype(str).str.strip().str.lower()
    es_i = tipo.isin(["ingreso", "ingresos"])
    es_e = tipo.isin(["egreso", "egresos"])

    # [PRIORIDAD 0 · LISTA DUEÑO #5] Máscaras de conteo operativo
    # (Consultas/Cirugías). Fuente ÚNICA de términos: financiero.
    # CATEGORIAS_OPERATIVAS — el mismo mapa que usa metricas_operativas.
    cat_norm = (
        cal[col_categoria].astype(str).str.strip().str.lower()
        .str.replace("-", "").str.replace(" ", "")
        if (col_categoria and col_categoria in cal.columns)
        else None
    )
    mascaras_oper: dict = {}
    if cat_norm is not None:
        for _clave, _termino in _financiero.CATEGORIAS_OPERATIVAS.items():
            mascaras_oper[_clave] = cat_norm.str.contains(_termino, case=False, na=False)

    def _serie(labels, valores):
        return {"labels": labels, "valores": [round(float(v), 2) for v in valores]}

    serie_m_i = serie_m_e = serie_m_m = None
    serie_a_i = serie_a_e = serie_a_m = None
    periodos: list = []
    conteos_m = None

    if es_fecha:
        try:
            f_dt = pd.to_datetime(cal[col_cal], errors="coerce")
            per = f_dt.dt.to_period("M")
            valido = per.notna()
            if bool(valido.any()):
                per_clave = per[valido].astype(str)
                tmp = pd.DataFrame({
                    "per": per_clave,
                    "i": monto.where(es_i & valido, 0.0)[valido],
                    "e": monto.where(es_e & valido, 0.0)[valido],
                    "mg": (monto.where(es_i & valido, 0.0) - monto.where(es_e & valido, 0.0))[valido],
                    # [PRIORIDAD 0] conteos operativos por período (aditivo)
                    **{
                        f"c_{k}": mask[valido].astype(int)
                        for k, mask in mascaras_oper.items()
                    },
                })
                col_counts = [f"c_{k}" for k in mascaras_oper]
                agg = tmp.groupby("per")[["i", "e", "mg", *col_counts]].sum().sort_index()
                claves = [str(k) for k in agg.index]
                anios = sorted({c[:4] for c in claves if c})
                multi = len(anios) > 1
                labels = []
                for c_clave in claves:
                    try:
                        anio_s, mes_s = c_clave[:4], c_clave[5:7]
                        nombre = _MES_POR_NUM.get(int(mes_s), mes_s).title()
                        labels.append(f"{nombre} {anio_s}" if multi else nombre)
                    except Exception:
                        labels.append(c_clave)
                serie_m_i = _serie(labels, agg["i"])
                serie_m_e = _serie(labels, agg["e"])
                serie_m_m = _serie(labels, agg["mg"])
                periodos = [{"clave": c_clave, "label": labels[i]} for i, c_clave in enumerate(claves)]
                # Serie anual: agrupo por año de la misma columna fecha.
                anio_sr = f_dt[valido].dt.year
                tmp_an = pd.DataFrame({
                    "anio": anio_sr,
                    "i": monto.where(es_i & valido, 0.0)[valido],
                    "e": monto.where(es_e & valido, 0.0)[valido],
                    "mg": (monto.where(es_i & valido, 0.0) - monto.where(es_e & valido, 0.0))[valido],
                })
                agg_an = tmp_an.groupby("anio")[["i", "e", "mg"]].sum().sort_index()
                labels_an = [str(a) for a in agg_an.index]
                serie_a_i = _serie(labels_an, agg_an["i"])
                serie_a_e = _serie(labels_an, agg_an["e"])
                serie_a_m = _serie(labels_an, agg_an["mg"])
                if mascaras_oper:
                    conteos_m = {
                        "claves": claves,
                        **{
                            k: [int(x) for x in agg[f"c_{k}"]]
                            for k in mascaras_oper
                        },
                    }
        except Exception as exc:
            logger.warning(
                "Serie mensual por fecha omitida (bloque_id=%d): %s",
                bloque_id, exc, exc_info=True,
            )
    else:
        try:
            mes_norm = cal[col_cal].astype(str).str.strip().str.lower()
            tmp = pd.DataFrame({
                "mes": mes_norm,
                "i": monto.where(es_i, 0.0),
                "e": monto.where(es_e, 0.0),
                "mg": monto.where(es_i, 0.0) - monto.where(es_e, 0.0),
                # [PRIORIDAD 0] conteos operativos por mes (aditivo)
                **{
                    f"c_{k}": mask.astype(int)
                    for k, mask in mascaras_oper.items()
                },
            })
            col_counts = [f"c_{k}" for k in mascaras_oper]
            agg = tmp.groupby("mes")[["i", "e", "mg", *col_counts]].sum()
            agg = agg[(agg["i"] != 0) | (agg["e"] != 0)]
            agg["_orden"] = [_MES_NUM.get(m, 99) for m in agg.index]
            agg = agg.sort_values("_orden")
            labels = [m.title() for m in agg.index]
            serie_m_i = _serie(labels, agg["i"])
            serie_m_e = _serie(labels, agg["e"])
            serie_m_m = _serie(labels, agg["mg"])
            periodos = [{"clave": m, "label": m.title()} for m in agg.index]
            if mascaras_oper:
                conteos_m = {
                    "claves": [str(m) for m in agg.index],
                    **{
                        k: [int(x) for x in agg[f"c_{k}"]]
                        for k in mascaras_oper
                    },
                }
        except Exception as exc:
            logger.warning(
                "Serie mensual textual omitida (bloque_id=%d): %s",
                bloque_id, exc, exc_info=True,
            )

    return {
        "_serie_mensual_ingresos": serie_m_i,
        "_serie_mensual_egresos": serie_m_e,
        "_serie_mensual_margen": serie_m_m,
        "_serie_anual_ingresos": serie_a_i,
        "_serie_anual_egresos": serie_a_e,
        "_serie_anual_margen": serie_a_m,
        "periodos": periodos,
        "_conteos_mensuales": conteos_m,
    }


def _calcular_benchmark_margen(serie_m: dict | None, serie_i: dict | None, n_periodos: int = 6) -> dict | None:
    """
    [P-3 · 31/08] Benchmark: promedio histórico del margen % de los últimos N
    períodos. Se calcula sobre las series mensuales de saldo (serie_m) e
    ingresos (serie_i) ya existentes — no reagrupa el DataFrame.

    Returns:
        dict | None: {promedio, n_periodos, valores:[{periodo, margen_pct}]} o
        None si no hay datos suficientes.
    """
    try:
        if not serie_m or not serie_i:
            return None
        vals_m = list(serie_m.get("valores") or [])
        vals_i = list(serie_i.get("valores") or [])
        labels = list(serie_m.get("labels") or [])
        if not vals_m or not vals_i or len(vals_m) < 1:
            return None
        # Tomar los últimos N períodos donde ambas series tienen datos.
        n = min(n_periodos, len(vals_m), len(vals_i))
        recientes = []
        for j in range(len(vals_m) - n, len(vals_m)):
            if j < 0:
                continue
            saldo = float(vals_m[j])
            ing = float(vals_i[j]) if j < len(vals_i) else 0.0
            margen_pct = round((saldo / ing) * 100, 2) if ing > 0 else None
            recientes.append({"periodo": labels[j] if j < len(labels) else f"p{j}", "margen_pct": margen_pct})
        validos = [r["margen_pct"] for r in recientes if r["margen_pct"] is not None]
        if not validos:
            return None
        return {
            "promedio": round(sum(validos) / len(validos), 2),
            "n_periodos": len(validos),
            "valores": recientes,
        }
    except Exception:
        logger.exception("Error calculando benchmark_margen")
        return None


def _variacion_vs_mes_anterior(
    df_calendario: pd.DataFrame,
    col_mes: str | None,
    col_m: str | None,
    col_t: str | None,
    margen_automatico: dict | None,
    mes_actual_filtro: str | None = None,
    col_fecha: str | None = None,
) -> dict | None:
    """
    [Frente C · E3-fix — 22/08] Calcula la variación del saldo (Ingreso−Egreso)
    del mes actual contra el mes calendario anterior.

    El mes actual se determina así:
      - Si hay filtro (`mes_actual_filtro`), ese es el mes actual.
      - Si no, el mes más reciente con datos del contexto calendario.

    [Resumen-vs · 28/08] Si el filtro trae año (clave ISO "2026-01" o label
    "Enero 2026") y existe columna de fecha real, el agrupamiento pasa a claves
    "YYYY-MM" para no mezclar Enero-2025 con Enero-2026. Fallback: agrupación
    por nombre textual (comportamiento previo, bloques sin fecha).

    Args:
        df_calendario: contexto completo (sin filtro mes) ya depurado.
        col_mes: nombre real de la columna Mes (o None).
        col_m: nombre real de la columna Monto.
        col_t: nombre real de la columna Tipo.
        margen_automatico: dict de L-3b.
        mes_actual_filtro: mes literal filtrado por el usuario (si aplica).
        col_fecha: columna de fecha real (si el calendario es fecha).

    Returns:
        dict con {"mes_actual", "mes_anterior", "variacion_pct", "saldo_actual",
        "saldo_anterior"} o None si no aplica.
    """
    try:
        if not (col_mes and col_m and col_t and margen_automatico):
            return None
        if col_mes not in df_calendario.columns or col_m not in df_calendario.columns:
            return None
        monto_c = pd.to_numeric(df_calendario[col_m], errors="coerce")
        tipo_c = df_calendario[col_t].astype(str).str.strip().str.lower()
        es_i = tipo_c.isin(["ingreso", "ingresos"])
        es_e = tipo_c.isin(["egreso", "egresos"])
        filtro_norm = str(mes_actual_filtro or "").strip().lower()
        filtro_con_anio = bool(
            filtro_norm
            and (_RE_CLAVE_MES.match(filtro_norm) or _RE_MES_ANIO.match(filtro_norm))
        )
        usar_fecha = bool(
            col_fecha and col_fecha in df_calendario.columns and filtro_con_anio
        )
        if usar_fecha:
            f_dt = pd.to_datetime(df_calendario[col_fecha], errors="coerce")
            clave_mes = f_dt.dt.strftime("%Y-%m").where(f_dt.notna(), "")
        else:
            clave_mes = df_calendario[col_mes].astype(str).str.strip().str.lower()
        tmp = pd.DataFrame({
            "mes": clave_mes,
            "saldo": monto_c.where(es_i, 0.0) - monto_c.where(es_e, 0.0),
            "ingreso": monto_c.where(es_i, 0.0),
            "egreso": monto_c.where(es_e, 0.0),
        })
        tmp = tmp[tmp["mes"] != ""]
        # [P-1 · 31/08] Agrupación extendida: saldo + ingreso + egreso por mes.
        agg_s = tmp.groupby("mes")["saldo"].sum()
        agg_i = tmp.groupby("mes")["ingreso"].sum()
        agg_e = tmp.groupby("mes")["egreso"].sum()
        if agg_s.empty:
            return None
        if usar_fecha:
            agg_s = agg_s.sort_index()
            agg_i = agg_i.sort_index()
            agg_e = agg_e.sort_index()
        else:
            order = [m for m in sorted(agg_s.index, key=lambda x: _MES_NUM.get(x, 99))]
            agg_s = agg_s.loc[[m for m in order if m in agg_s.index]]
            agg_i = agg_i.loc[[m for m in order if m in agg_i.index]] if not agg_i.empty else pd.Series(dtype=float)
            agg_e = agg_e.loc[[m for m in order if m in agg_e.index]] if not agg_e.empty else pd.Series(dtype=float)

        mes_actual = filtro_norm
        if usar_fecha:
            m_iso_f = _RE_CLAVE_MES.match(mes_actual)
            if m_iso_f:
                mes_actual = f"{m_iso_f.group(1)}-{int(m_iso_f.group(2)):02d}"
            else:
                m_anio_f = _RE_MES_ANIO.match(mes_actual)
                num = _MES_NUM.get(m_anio_f.group(1)) if m_anio_f else None
                mes_actual = (
                    f"{m_anio_f.group(2)}-{num:02d}" if (m_anio_f and num) else ""
                )
        if mes_actual and mes_actual not in agg_s.index:
            mes_actual = ""
        if not mes_actual:
            mes_actual = str(agg_s.index[-1])

        def _valor(o, idx):
            try: return float(o.loc[idx])
            except Exception: return None

        sa = _valor(agg_s, mes_actual)
        ia = _valor(agg_i, mes_actual)
        ea = _valor(agg_e, mes_actual)

        pos = list(agg_s.index).index(mes_actual)
        if pos >= 1:
            mes_anterior = str(agg_s.index[pos - 1])
            sant = _valor(agg_s, mes_anterior)
            iant = _valor(agg_i, mes_anterior)
            eant = _valor(agg_e, mes_anterior)
        else:
            mes_anterior = None
            sant = iant = eant = None

        variacion = None
        if sant not in (None, 0.0):
            variacion = round(((sa - sant) / abs(sant)) * 100, 1)
        var_ing = var_egr = None
        if iant not in (None, 0.0):
            var_ing = round(((ia - iant) / abs(iant)) * 100, 1)
        if eant not in (None, 0.0):
            var_egr = round(((ea - eant) / abs(eant)) * 100, 1)
        # Δpp en Margen % (puntos porcentuales, no % del %)
        mp_act = ((sa / ia) * 100) if (sa is not None and ia not in (None, 0.0)) else None
        mp_ant = ((sant / iant) * 100) if (sant is not None and iant not in (None, 0.0)) else None
        dpp = None
        if mp_act is not None and mp_ant is not None:
            dpp = round(mp_act - mp_ant, 1)

        if usar_fecha:
            label_actual = _label_de_clave_mensual(mes_actual)
            label_anterior = (
                _label_de_clave_mensual(mes_anterior) if mes_anterior else None
            )
        else:
            label_actual = mes_actual.title()
            label_anterior = mes_anterior.title() if mes_anterior else None
        return {
            "mes_actual": label_actual,
            "mes_anterior": label_anterior,
            "saldo_actual": sa,
            "saldo_anterior": sant or None,
            "variacion_pct": variacion,
            # [P-1] Δ% por KPI card:
            "ingreso_actual": ia or None, "ingreso_anterior": iant or None,
            "var_ingreso_pct": var_ing,
            "egreso_actual": ea or None, "egreso_anterior": eant or None,
            "var_egreso_pct": var_egr,
            # [P-1] Δpp Margen %:
            "margenpct_actual": mp_act, "margenpct_anterior": mp_ant,
            "delta_pp": dpp,
        }
    except Exception:
        logger.exception("Error en variación vs mes anterior")
        return None


def _margen_por_entidad(
    df: pd.DataFrame,
    col_tipo: str | None,
    col_categoria: str | None,
    col_concepto: str | None,
    col_monto: str | None,
    conceptos_genericos: list[str] | None = None,
) -> dict | None:
    """
    [B-2 — 22/08] Margen por Entidad (cliente/paciente/procedimiento, según
    cómo nombre el usuario a sus conceptos).

    Réplica del MARGEN POR ENTIDAD del Excel del admin: las ENTIDADES se
    detectan desde los Conceptos de INGRESOS cuyo nombre también aparece
    (substring) en Conceptos de EGRESOS. Para cada entidad:
        ingresos (precio cobrado) - egresos asignados = utilidad, %margen.

    Heurística determinística (no frágil): matching por substring case-
    insensitive, entidades ordenadas por longitud descendente para evitar
    falsos positivos de prefijos.

    Returns:
        dict {"entidades": [{entidad, ingresos, egresos, utilidad,
        margen_pct, ingresos_detalle, egresos_detalle}...]} o None si no aplica.
    """
    try:
        if not (col_tipo and col_concepto and col_monto):
            return None
        if any(c not in df.columns for c in (col_tipo, col_concepto, col_monto)):
            return None

        tipo = df[col_tipo].astype(str).str.strip().str.lower()
        monto = pd.to_numeric(df[col_monto], errors="coerce").fillna(0.0)
        concepto = df[col_concepto].astype(str).str.strip()

        ing_mask = tipo.isin(["ingreso", "ingresos"])
        egr_mask = tipo.isin(["egreso", "egresos"])
        if not ing_mask.any() or not egr_mask.any():
            return None

        # [A1-H1] Los conceptos genéricos a excluir YA NO viven en código:
        # llegan por config del bloque -> margen_entidad.exclusiones
        # (default [] = no excluir nada). Ver _margen_exclusiones_de_config().
        genericas = {
            str(g).strip().lower()
            for g in (conceptos_genericos or [])
            if str(g).strip()
        }
        # Entidades candidatas: conceptos de INGRESOS con 2+ palabras
        # capitalizadas (nombres propios), que NO sean conceptos genéricos.
        candidatas = []
        vistos = set()
        for c in concepto[ing_mask & ~concepto.str.lower().isin(genericas)].unique():
            cs = str(c).strip()
            palabras = cs.split()
            # nombre propio: 2+ palabras, cada una inicia mayúscula
            if len(palabras) >= 2 and all(
                p[0].isupper() and p[1:].islower() for p in palabras if len(p) > 1
            ):
                clave = cs.lower()
                if clave not in vistos:
                    vistos.add(clave)
                    candidatas.append(cs)
        if not candidatas:
            return None

        # asignar egresos a entidades por substring (longitud desc evita
        # que "Rosmary" capture "Rosmary Morales")
        egr_concepto = concepto[egr_mask]
        egr_monto = monto[egr_mask]
        asignaciones = {}
        for ent in sorted(candidatas, key=len, reverse=True):
            mask = egr_concepto.str.contains(re.escape(ent), case=False, na=False)
            asignaciones[ent] = float(egr_monto[mask].sum())

        # ingresos por entidad (match exacto del concepto o substring)
        resultado = []
        for ent in candidatas:
            ing_ent = float(monto[ing_mask & concepto.str.strip().str.lower().isin([ent.lower()])].sum())
            egr_ent = asignaciones.get(ent, 0.0)
            if ing_ent == 0 and egr_ent == 0:
                continue
            utilidad = round(ing_ent - egr_ent, 2)
            pct = round((utilidad / ing_ent * 100), 1) if ing_ent > 0 else None
            # [Plan Beta · 24/08] Detalle por concepto: hasta 5 ingresos y
            # 5 egresos de cada entidad, para el informe exportable.
            ing_mask_ent = ing_mask & concepto.str.strip().str.lower().isin([ent.lower()])
            egr_mask_ent = egr_concepto.str.contains(re.escape(ent), case=False, na=False)
            ing_detalle = [
                {"concepto": str(fila), "monto": round(float(monto[ix]), 2)}
                for ix, fila in concepto[ing_mask_ent].items()
            ][:5]
            egr_detalle = [
                {"concepto": str(fila), "monto": round(float(monto.loc[ix]), 2)}
                for ix, fila in egr_concepto[egr_mask_ent].items()
            ][:5]
            resultado.append({
                "entidad": ent[:50],
                "ingresos": round(ing_ent, 2),
                "egresos": round(egr_ent, 2),
                "utilidad": utilidad,
                "margen_pct": pct,
                "ingresos_detalle": ing_detalle,
                "egresos_detalle": egr_detalle,
            })
        resultado.sort(key=lambda x: x["utilidad"], reverse=True)
        if not resultado:
            return None
        return {"entidades": resultado}
    except Exception:
        logger.exception("Error calculando margen por entidad")
        return None



def _modulos_derivados_automaticos(
    df: pd.DataFrame,
    col_monto: str | None,
    col_tipo: str | None,
    col_categoria: str | None,
    col_concepto: str | None,
) -> dict | None:
    """
    [Frente C · E4-derivados — 22/08] Módulos automáticos generados desde la
    matriz, réplica de las tablas derivadas del Excel del admin:

      - por_concepto: desglose jerárquico Categoría→Concepto con Ingresos y
        Egresos separados + conteos (réplica de su tabla "Gastos":
        Concepto/Real). Respeta los filtros activos (mes/tipo).
      - dimensiones: mapa de columnas detectadas (para que el frontend sepa
        qué módulos puede ofrecer sin preguntar al usuario).

    Args:
        df: DataFrame YA filtrado (mes/tipo/categorías).
        col_m/col_tipo/col_categoria/col_concepto: nombres reales de columnas.

    Returns:
        dict o None si no hay suficientes dimensiones.
    """
    try:
        if not col_monto or col_monto not in df.columns:
            return None
        col_mes_local = _encontrar_columna(df, "mes")
        monto = pd.to_numeric(df[col_monto], errors="coerce").fillna(0.0)
        tipo_norm = (
            df[col_tipo].astype(str).str.strip().str.lower()
            if col_tipo and col_tipo in df.columns
            else pd.Series("", index=df.index)
        )
        es_i = tipo_norm.isin(["ingreso", "ingresos"])
        es_e = tipo_norm.isin(["egreso", "egresos"])

        por_concepto = []
        if col_concepto and col_concepto in df.columns:
            cat_col = col_categoria if (col_categoria and col_categoria in df.columns) else None
            base = {
                "cat": (
                    generic_engine.etiqueta_dimension(df[cat_col])
                    if cat_col else pd.Series("General", index=df.index)
                ),
                "con": generic_engine.etiqueta_dimension(df[col_concepto]),
                "i": monto.where(es_i, 0.0),
                "e": monto.where(es_e, 0.0),
                "ni": es_i.astype(int),
                "ne": es_e.astype(int),
            }
            tmp = pd.DataFrame(base)
            # [Fase 7] Las filas con dimensión vacía (cat/con = NA) ya quedaron
            # excluidas por el dropna implícito del groupby de abajo.
            tmp = tmp[(tmp["i"] != 0) | (tmp["e"] != 0)]
            if not tmp.empty:
                agg = (
                    tmp.groupby(["cat", "con"])
                    .agg(i=("i", "sum"), e=("e", "sum"), ni=("ni", "sum"), ne=("ne", "sum"))
                    .reset_index()
                )
                agg["_peso"] = agg["i"] + agg["e"]
                agg = agg.sort_values("_peso", ascending=False)
                # [A1-H4] Vectorizado: to_dict("records") sustituye iterrows
                # (convención del proyecto). Misma salida, misma regla top-60.
                por_concepto = [
                    {
                        "categoria": str(r["cat"])[:40],
                        "concepto": str(r["con"])[:60],
                        "ingresos": round(float(r["i"]), 2),
                        "egresos": round(float(r["e"]), 2),
                        "conteo_ingresos": int(r["ni"]),
                        "conteo_egresos": int(r["ne"]),
                    }
                    for r in agg.head(60).to_dict("records")
                ]

        return {
            "por_concepto": por_concepto,
            # [E4-dims] Agregaciones I/E por CADA dimensión categórica detectada:
            # alimenta los widgets automáticos del frontend (tablas + gráficos).
            "por_dimension": _agregaciones_por_dimension(
                df, col_monto, col_tipo, col_mes_local,
                excluir=[col_monto, col_concepto],
            ),
        }
    except Exception:
        logger.exception("Error calculando módulos derivados automáticos")
        return None


def _agregaciones_por_dimension(
    df: pd.DataFrame,
    col_monto: str,
    col_tipo: str | None,
    col_mes: str | None,
    excluir: list | None = None,
) -> dict:
    """
    [E4-dims] Para cada columna categórica del dataset genera la agregación
    Ingresos/Egresos/Conteos/Saldo. Excluye columnas numéricas y fechas.

    Returns:
        dict {nombre_columna: [{valor, ingresos, egresos, conteos, saldo}...]}.
    """
    try:
        excluir = excluir or []
        monto = pd.to_numeric(df[col_monto], errors="coerce").fillna(0.0)
        tipo_norm = (
            df[col_tipo].astype(str).str.strip().str.lower()
            if col_tipo and col_tipo in df.columns
            else pd.Series("", index=df.index)
        )
        es_i = tipo_norm.isin(["ingreso", "ingresos"])
        es_e = tipo_norm.isin(["egreso", "egresos"])

        salida = {}
        for c in df.columns:
            cs = str(c).strip().lower()
            if c == col_monto or cs in ("monto", "fecha") or c in (excluir or []):
                continue
            try:
                if not (df[c].dtype == object or str(df[c].dtype) == "category"):
                    continue
                nuniq = df[c].dropna().astype(str).str.strip().nunique()
                if nuniq < 1 or nuniq > 200:
                    continue
            except Exception as exc:
                # [DEBT-S112] Columna problemática: se excluye de las dimensiones.
                logger.debug("Dimensión %r descartada por heurística: %s", c, exc)
                continue

            tmp = pd.DataFrame({
                # [Fase 7] etiqueta_dimension: vacíos -> NA -> el groupby los
                # excluye (antes: astype(str) convertía NaN en "nan"/"—").
                "dim": generic_engine.etiqueta_dimension(df[c]),
                "i": monto.where(es_i, 0.0),
                "e": monto.where(es_e, 0.0),
                "ni": es_i.astype(int),
                "ne": es_e.astype(int),
            })
            agg = tmp.groupby("dim").agg(
                i=("i", "sum"), e=("e", "sum"), ni=("ni", "sum"), ne=("ne", "sum")
            )
            agg = agg[(agg["i"] != 0) | (agg["e"] != 0)]
            agg["_peso"] = agg["i"] + agg["e"]
            agg = agg.sort_values("_peso", ascending=False).head(40)
            filas = [{
                "valor": str(k)[:50],
                "ingresos": round(float(r["i"]), 2),
                "egresos": round(float(r["e"]), 2),
                "saldo": round(float(r["i"] - r["e"]), 2),
                "conteo_ingresos": int(r["ni"]),
                "conteo_egresos": int(r["ne"]),
            } for k, r in agg.iterrows()]
            if filas:
                salida[str(c)] = filas
        return salida
    except Exception:
        logger.exception("Error calculando agregaciones por dimensión")
        return {}
    except Exception:
        logger.exception("Error calculando módulos derivados automáticos")
        return None


def obtener_analytics(
    bloque_id: int,
    columna_x: str = None,
    columna_y: str = None,
    agregacion: str = "suma",
    meta: float = None,
    categorias_excluidas: list = None,
    filtro_mes: str = None,
    filtro_tipo: str = None,
    filtro_mes_desde: str = None,
    filtro_mes_hasta: str = None,
    filtro_fecha_desde: str = None,
    filtro_fecha_hasta: str = None,
) -> dict:
    """
    Punto de entrada único del motor analítico genérico (Fundacional §11.1).

    El perfilado de columnas (profiler) corre SIEMPRE sobre todo el bloque.
    Los KPIs y la serie de gráfico solo se calculan si el llamador especifica
    columna_y (y columna_x cuando aplica).

    [v3.3.0] Despacho por tipo_bloque: tendencia para detalle/lista_entidad,
    valor_destacado para resumen_totales, nombre_entidad_singular para
    lista_entidad (col_entidad — aún no existe el campo, devuelve None).

    [Fix C-1] `categorias_excluidas` es el filtro visual de "Categorías visibles"
    (Fundacional §6.1): se excluyen EN MEMORIA las filas de columna_x listadas,
    y KPIs, serie, anomalías y margen automático se calculan sobre ese recorte.
    NUNCA se modifica el Parquet ni el DataFrame persistido — es presentación.

    [Frente C · E1 — 21/08] `filtro_mes` y `filtro_tipo` replican el
    "Selecciona el mes" (B2) del Excel del admin: recortan EN MEMORIA todas las
    filas del mes/tipo indicados ANTES de KPIs/serie/rankings/anomalías/margen.
    Las columnas se localizan por nombre normalizado ("Mes"/"Tipo"); como
    fallback para Tipo se usa columna_x si sus valores son Ingreso/Egreso.
    Además se excluyen del análisis las FILAS FANTASMA (Monto vacío + Tipo y
    Categoría vacíos — filas pre-arrastradas de plantilla) y se expone
    `filas_ignoradas` para transparencia total.
    """
    bloque = db.session.get(CoreBloque, bloque_id)
    if bloque is None:
        raise KeyError(f"El bloque con id={bloque_id} no existe.")

    tipo_bloque = _despachar_por_tipo_bloque(bloque)
    df = _cargar_dataframe_bloque(bloque)
    decimal_places = _decimal_places_bloque(bloque)

    logger.info(
        "Perfilando bloque_id=%d tipo_bloque=%r columna_x=%r columna_y=%r decimal_places=%d",
        bloque_id, tipo_bloque, columna_x, columna_y, decimal_places,
    )

    perfil_columnas = profiler.perfilar_dataframe(df)

    # [Fase L-1 — "importa y ve"] Si el llamador no envía ejes (primer request
    # del dashboard, PDF de bloques sin mapeo, etc.), se resuelven automáticamente:
    # Y = col_monto → primera numérica no-identificador (R23); X = col_categoria
    # → col_fecha → primera texto/fecha. Así la narrativa y los KPIs se generan
    # desde el primer request, no en un segundo con placeholders.
    ejes_automaticos = False
    if not columna_y:
        columna_x, columna_y = _resolver_ejes_por_defecto(
            bloque, perfil_columnas, columna_x, columna_y, df=df,
        )
        ejes_automaticos = bool(columna_y)

    # [Ficha §2.5] Ejes resueltos automáticamente, reutilizados en la
    # narrativa (explica el motivo) y en el contrato. None cuando el llamador
    # eligió los ejes explícitamente.
    ejes_auto_usados = (
        {"columna_x": columna_x, "columna_y": columna_y} if ejes_automaticos else None
    )

    # [Fix C-1] Filtro visual de categorías (Fundacional §6.1). `columna_x` es
    # la dimensión de agrupación: excluir aquí equivale a desmarcar una
    # categoría en "Categorías visibles". El recorte es EN MEMORIA (copia vía
    # filtrar_por_categorias) — nunca se escribe al Parquet (§6.1, no
    # negociable). El perfil de columnas se conserva COMPLETO (los checkboxes
    # necesitan el catálogo completo para poder volver a marcar categorías).
    categorias_disponibles: list = []
    if columna_x and columna_x in df.columns:
        categorias_disponibles = sorted(
            {str(v) for v in df[columna_x].dropna().unique()}
        )
    if categorias_excluidas:
        # [FIX 23/08] Excluir sobre TODAS las columnas de dimensión relevantes,
        # no solo columna_x: los chips "Categorías visibles" muestran las
        # categorías FINANCIERAS (categoria/concepto/tipo), que pueden diferir
        # de columna_x — si solo se filtrara columna_x, desmarcar una categoría
        # no tenía ningún efecto visible en los donuts/rankings/resúmenes.
        _objetivos_c1: list = []
        for _cand in (
            columna_x,
            getattr(bloque, "col_categoria", None),
            getattr(bloque, "col_tipo", None),
            _encontrar_columna(df, "tipo"),
            _detectar_columna_categoria(df),
        ):
            if _cand and _cand in df.columns and _cand not in _objetivos_c1:
                _objetivos_c1.append(_cand)
        for col_obj in _objetivos_c1:
            filas_antes = len(df)
            df = generic_engine.filtrar_por_categorias(
                df, col_obj, categorias_excluidas
            )
            if len(df) != filas_antes:
                logger.info(
                    "Filtro visual C-1 (%s): %d categorías excluidas en "
                    "bloque_id=%d -> %d filas para KPIs/serie",
                    col_obj, len(categorias_excluidas), bloque_id, len(df),
                )

    # [Frente C · E1] Filtros globales por Mes y Tipo + limpieza de filas
    # fantasma. Mismo principio que C-1: recorte EN MEMORIA sobre la copia
    # local, ANTES de KPIs/serie/margen. Réplica del "Selecciona el mes" (B2).
    col_monto_ref = _encontrar_columna(df, "monto")
    col_mes = _encontrar_columna(df, "mes")
    col_tipo = _encontrar_columna(df, "tipo")
    # [Plan F · 23/08] Columna de calendario para series temporales (mes textual
    # ó fecha real). Alimenta el rango de fechas y la Tendencia Mensual/Anual.
    col_cal, es_calendario_fecha = _detectar_columna_calendario(
        bloque, df, perfil_columnas,
    )
    # [Fase 4] Convertir fechas del CALENDARIO a claves de período según el
    # tipo de columna calendario (Fecha real -> ISO "YYYY-MM"; Mes textual ->
    # nombre normalizado). Estas claves tienen PRIORIDAD sobre mes_desde/hasta.
    clave_fd = clave_fh = None
    if filtro_fecha_desde or filtro_fecha_hasta:
        clave_fd, clave_fh = _fechas_a_claves_rango(
            es_calendario_fecha, filtro_fecha_desde, filtro_fecha_hasta
        )
    if col_tipo is None and columna_x and columna_x in df.columns:
        valores_x = {
            str(v).strip().lower() for v in df[columna_x].dropna().unique()
        }
        if valores_x & {"ingreso", "ingresos", "egreso", "egresos"}:
            col_tipo = columna_x  # la dimensión elegida ES la de Ingreso/Egreso

    # [Frente C · E3-fix 22/08] CONTEXTO CALENDARIO: copia del dataset con C-1
    # aplicado pero SIN filtros mes/tipo. La serie mensual financiera y el
    # selector de meses SIEMPRE se calculan sobre este contexto completo:
    # filtrar "Marzo" no debe hacer desaparecer los demás meses del selector
    # ni de la gráfica mensual (bug reportado por el admin).
    df_calendario = df

    filtro_aplicado: dict = {}
    if filtro_mes:
        # [Resumen-vs · 28/08] La máscara acepta clave ISO ("2026-01"), label
        # con año ("Enero 2026") y nombre simple ("enero" — retrocompatible).
        mask_mes = _mascara_periodo(
            df, filtro_mes, col_cal, es_calendario_fecha, col_mes=col_mes,
        )
        if mask_mes is not None and bool(mask_mes.any()):
            df = df[mask_mes]
            filtro_aplicado["mes"] = filtro_mes
        elif mask_mes is not None:
            logger.warning(
                "filtro_mes=%r sin coincidencias (bloque_id=%d)",
                filtro_mes, bloque_id,
            )
        else:
            logger.warning(
                "filtro_mes=%r ignorado: el bloque_id=%d no tiene columna "
                "Mes ni calendario interpretable",
                filtro_mes, bloque_id,
            )
    # [Frente C · E4-dinámico 23/08] Rango de períodos (desde/hasta): permite
    # ver la 'historia' del Excel en un rango (ej. Febrero→Mayo, o 2025-02 →
    # 2026-05 cuando hay columna Fecha) en TODAS las gráficas/metricas.
    # [Fase 4] PRIORIDAD: fechas del calendario -> claves derivadas; fallback:
    # claves mes textual (compat). Mismo mecanismo para df analítico.
    eff_desde = clave_fd or filtro_mes_desde
    eff_hasta = clave_fh or filtro_mes_hasta
    if (eff_desde or eff_hasta) and col_cal and col_cal in df.columns:
        df, rango_aplicado = _aplicar_rango_fechas(
            df, col_cal, es_calendario_fecha, eff_desde, eff_hasta,
        )
        if rango_aplicado:
            filtro_aplicado["mes_desde"] = filtro_mes_desde or ""
            filtro_aplicado["mes_hasta"] = filtro_mes_hasta or ""
            filtro_aplicado["rango_meses"] = "si"
        else:
            logger.warning("Rango de meses sin coincidencias (bloque_id=%d)", bloque_id)

    if filtro_tipo:
        if col_tipo:
            mask_tipo = (
                df[col_tipo].astype(str).str.strip().str.lower()
                == filtro_tipo.strip().lower()
            )
            if bool(mask_tipo.any()):
                df = df[mask_tipo]
                filtro_aplicado["tipo"] = filtro_tipo
            else:
                logger.warning(
                    "filtro_tipo=%r sin coincidencias en %r (bloque_id=%d)",
                    filtro_tipo, col_tipo, bloque_id,
                )
        else:
            logger.warning(
                "filtro_tipo=%r ignorado: bloque_id=%d sin columna Tipo",
                filtro_tipo, bloque_id,
            )

    # Filas fantasma (plantilla arrastrada): Monto vacío + Categoría y Tipo
    # vacíos. No aportan al análisis y ensuciaban rankings/tablas (caso real
    # PUERTO ORDAZ: 214 filas). Se excluyen del df de análisis con contador.
    filas_ignoradas = 0
    col_cat_ref = _encontrar_columna(df, "categoria")
    if (
        col_monto_ref and col_cat_ref and col_tipo
        and col_monto_ref in df.columns and col_cat_ref in df.columns
    ):
        monto_num = pd.to_numeric(df[col_monto_ref], errors="coerce")
        cat_vacia = df[col_cat_ref].isna() | (
            df[col_cat_ref].astype(str).str.strip() == ""
        )
        tipo_vacio = df[col_tipo].isna() | (
            df[col_tipo].astype(str).str.strip() == ""
        )
        fantasma = monto_num.isna() & cat_vacia & tipo_vacio
        filas_ignoradas = int(fantasma.sum())
        if filas_ignoradas:
            logger.info(
                "Filas fantasma excluidas del análisis (bloque_id=%d): %d",
                bloque_id, filas_ignoradas,
            )
            df = df[~fantasma]

    # [Frente C · E4-dinámico] RECALCULAR el perfil sobre el df YA filtrado
    # (mes/tipo/rango/categorías): así histograma, ojiva, diagrama de caja,
    # cuartiles/deciles y anomalías cuentan la 'historia' del período
    # seleccionado (de X mes a Y mes, o un mes, o todo), no solo el total.
    # El catálogo de categorías completas ya se conservó en
    # `categorias_disponibles` (no se pierde para los checkboxes).
    if len(df) > 0:
        perfil_columnas = profiler.perfilar_dataframe(df, decimal_places)

    kpis = None
    serie_grafico = None
    tendencia = None
    valor_destacado = None
    nombre_entidad_singular = None
    lista_anomalias = []
    narrativa = ""
    perfil_y = None
    perfil_x = None

    if tipo_bloque == "lista_entidad":
        # col_entidad no existe aún en el esquema — devuelve None (gap PG-3).
        nombre_entidad_singular = getattr(bloque, "col_entidad", None)

    if columna_y:
        if columna_y not in perfil_columnas:
            raise ValueError(
                f"La columna '{columna_y}' no existe en los datos de este bloque. "
                "Revisa el selector de Eje Y."
            )
        perfil_y = perfil_columnas[columna_y]
        # [L-4b] Columnas llegadas como object (fila de sub-encabezado /
        # calamine): si la heurística las eligió, convertir a numérico en la
        # copia local del DataFrame para que KPIs/serie/anomalías no intenten
        # operar sobre strings (el Parquet nunca se modifica).
        if perfil_y.get("tipo") != "numerico":
            df[columna_y] = pd.to_numeric(df[columna_y], errors="coerce")
        kpis = generic_engine.calcular_kpis_genericos(
            df, columna_y, meta=meta, columna_es_identificador=perfil_y["es_identificador"],
            decimal_places=decimal_places,
        )
        lista_anomalias = generic_engine.detectar_anomalias(df[columna_y])

        if columna_x:
            if columna_x not in perfil_columnas:
                raise ValueError(
                    f"La columna '{columna_x}' no existe en los datos de este bloque. "
                    "Revisa el selector de Eje X."
                )
            perfil_x = perfil_columnas[columna_x]
            serie_grafico = generic_engine.construir_serie_grafico(
                df, columna_x, columna_y, agregacion, decimal_places=decimal_places,
            )
            # [Frente C · E1.2] Orden cronológico cuando la dimensión es la
            # columna Mes (texto): por calendario (ene→dic), no alfabético.
            if col_mes and columna_x == col_mes and serie_grafico:
                try:
                    serie_grafico = sorted(
                        serie_grafico,
                        key=lambda d: _MES_NUM.get(
                            str(d.get("x", "")).strip().lower(), 99
                        ),
                    )
                except Exception:
                    logger.debug(
                        "Orden cronológico de serie omitido", exc_info=True
                    )
            if tipo_bloque in ("detalle", "lista_entidad") and serie_grafico:
                tendencia = rankings.calcular_tendencia_serie(
                    serie_grafico, decimal_places=decimal_places,
                )

        if tipo_bloque == "resumen_totales" and kpis is not None:
            valor_destacado = rankings.calcular_valor_destacado(
                {kpis["columna"]: kpis["suma"]}, decimal_places=decimal_places,
            )

        narrativa = generar_narrativa(
            perfil_y, kpis, perfil_x, lista_anomalias,
            tendencia=tendencia,
            valor_destacado=valor_destacado,
            nombre_entidad_singular=nombre_entidad_singular,
            ejes_auto=ejes_auto_usados,
        )
    else:
        narrativa = (
            f"Este bloque tiene {len(df.columns)} columnas y {len(df)} filas. "
            "Selecciona una columna para el Eje Y para ver estadísticas y narrativa detallada."
        )

    # [L-3b] Margen automático Ingreso−Egreso: heurística sobre una columna de
    # tipo/clasificación cuyos valores contienen "ingreso(s)"/"egreso(s)".
    # [Frente C · E3-fix] PRIORIDAD: buscar columna llamada "Tipo" por nombre
    # (caso real PUERTO ORDAZ: Fecha/Mes/Tipo/Categoria/... donde el eje X
    # elegido puede ser Categoria pero el Ingreso/Egreso vive en "Tipo").
    # Fallback histórico: el propio eje X.
    columna_tipo_automatica = _encontrar_columna(df, "tipo")
    if (
        columna_tipo_automatica is None
        and columna_x and columna_x in df.columns
        and df[columna_x].astype(str).str.strip().str.lower()
            .isin(["ingreso", "ingresos", "egreso", "egresos"]).any()
    ):
        columna_tipo_automatica = columna_x
    margen_automatico = _calcular_margen_automatico(df, columna_y, columna_tipo_automatica)

    # [Frente C · E3] Resumen financiero para el frontend. dashboard.js YA trae
    # el "modo clínica" completo (tarjetas I/E/Margen + gráfico mensual 2 series
    # + donuts por categoría) leyendo data.business — que el motor genérico
    # nunca calculó. Aquí se expone con EXACTAMENTE las claves que el JS espera.
    # Todo sobre el df YA filtrado (C-1 + mes + tipo).
    business = None
    periodos_calendario: list = []
    proyeccion_series: dict = {}
    if margen_automatico:
        try:
            col_t = margen_automatico["columna_tipo"]
            col_m = margen_automatico["columna_monto"]
            monto_num = pd.to_numeric(df[col_m], errors="coerce")
            tipo_norm = df[col_t].astype(str).str.strip().str.lower()
            es_i = tipo_norm.isin(["ingreso", "ingresos"])
            es_e = tipo_norm.isin(["egreso", "egresos"])

            # [Plan F · 23/08] Series calendario UNIFICADAS (mensual + anual) desde el
            # contexto completo, con fallback a la Fecha real cuando no hay
            # columna "Mes". El rango [desde/hasta] se aplica aquí también para
            # que la Tendencia respete la ventana "de fecha a fecha".
            # E3-fix conservado: el filtro de UN mes NO achica la gráfica — solo
            # el rango explícito (Desde/Hasta) acota el contexto calendario.
            serie_esc = _construir_series_calendario(
                df_calendario,
                col_cal, es_calendario_fecha,
                col_m, col_t,
                limite_desde=(clave_fd or filtro_mes_desde),
                limite_hasta=(clave_fh or filtro_mes_hasta),
                bloque_id=bloque_id,
                col_categoria=_encontrar_columna(df, "categoria"),
            )
            serie_i = serie_esc["_serie_mensual_ingresos"]
            serie_e = serie_esc["_serie_mensual_egresos"]
            serie_m = serie_esc["_serie_mensual_margen"]
            serie_an_i = serie_esc["_serie_anual_ingresos"]
            serie_an_e = serie_esc["_serie_anual_egresos"]
            serie_an_m = serie_esc["_serie_anual_margen"]
            periodos_calendario = serie_esc["periodos"]

            # [Fase 6 · PROYECCIÓN MATEMÁTICA] Niveles y tendencia POR SERIE
            # (Ingresos/Egresos/Margen) sobre los períodos ya filtrados por el
            # calendario. Reutiliza rankings.calcular_tendencia_serie (regresión
            # lineal simple) con índice ordinal — sin duplicar lógica.
            def _proyeccion_de(serie):
                if not serie or not serie.get("valores"):
                    return None
                valores = [float(v) for v in serie["valores"]]
                n = len(valores)
                if n < 2:
                    return {
                        "periodos": n, "promedio": round(sum(valores), 2),
                        "acumulado": round(sum(valores), 2),
                        "direccion": None, "pendiente": None, "proximo": None,
                    }
                tend = rankings.calcular_tendencia_serie(
                    [{"x": str(i + 1), "y": v} for i, v in enumerate(valores)],
                )
                acum = sum(valores)
                prox = (tend["y"] + tend["pendiente"]) if tend else None
                return {
                    "periodos": n,
                    "promedio": round(acum / n, 2),
                    "acumulado": round(acum, 2),
                    "direccion": tend["direccion"] if tend else None,
                    "pendiente": tend["pendiente"] if tend else None,
                    "proximo": round(float(prox), 2) if prox is not None else None,
                }

            proyeccion_series = {
                "ingresos": _proyeccion_de(serie_i),
                "egresos": _proyeccion_de(serie_e),
                "margen": _proyeccion_de(serie_m),
            }

            ingresos_por_cat, egresos_por_cat = [], []
            # [FIX 23/08] Misma heurística centralizada (_detectar_columna_categoria)
            # que usa el filtro C-1 — garantiza que los donuts/rankings y el
            # filtro "Categorías visibles" operen sobre la MISMA columna.
            col_cat_fin = _detectar_columna_categoria(df, col_t=col_t, col_m=col_m)
            if col_cat_fin:
                tmp2 = pd.DataFrame({
                    "cat": generic_engine.etiqueta_dimension(df[col_cat_fin]),
                    "i": monto_num.where(es_i, 0.0),
                    "e": monto_num.where(es_e, 0.0),
                    "ni": es_i.astype(int),
                    "ne": es_e.astype(int),
                })
                agg2 = tmp2.groupby("cat").agg(
                    i=("i", "sum"), e=("e", "sum"), ni=("ni", "sum"), ne=("ne", "sum"),
                )
                agg2 = agg2[(agg2["i"] != 0) | (agg2["e"] != 0)]
                for k, r in agg2[agg2["i"] > 0].sort_values("i", ascending=False).iterrows():
                    ingresos_por_cat.append({
                        "categoria": str(k)[:40], "monto": round(float(r["i"]), 2),
                        "conteo": int(r["ni"]),
                    })
                for k, r in agg2[agg2["e"] > 0].sort_values("e", ascending=False).iterrows():
                    egresos_por_cat.append({
                        "categoria": str(k)[:40], "monto": round(float(r["e"]), 2),
                        "conteo": int(r["ne"]),
                    })

            # [P-2 · 31/08] Hoistar métricas operativas a variable local ANTES
            # del dict para que `ticket_promedio`/`n_operaciones` las lean.
            _mo = _financiero.calcular_metricas_operativas(
                df,
                col_monto=col_m,
                col_tipo=col_tipo,
                col_categoria=_encontrar_columna(df, "categoria"),
            )
            business = {
                "total_ingresos": round(margen_automatico["ingresos"], 2),
                "total_egresos": round(margen_automatico["egresos"], 2),
                "margen_neto": round(margen_automatico["margen"], 2),
                "n_ingresos": margen_automatico.get("n_ingresos"),
                "n_egresos": margen_automatico.get("n_egresos"),
                "_serie_mensual_ingresos": serie_i,
                "_serie_mensual_egresos": serie_e,
                "_serie_mensual_margen": serie_m,
                # [Plan F · 22/08] Series ANUALES para "Tendencia anual".
                "_serie_anual_ingresos": serie_an_i,
                "_serie_anual_egresos": serie_an_e,
                "_serie_anual_margen": serie_an_m,
                # [Fase 6] Proyección matemática por serie (niveles + tendencia)
                "proyeccion_series": proyeccion_series,
                # [Plan F · 23/08] Períodos disponibles para poblar los selectores
                # "Desde/Hasta" y el selector de la Tendencia. Cronológica.
                "periodos": periodos_calendario,
                "ingresos_por_categoria": ingresos_por_cat,
                "egresos_por_categoria": egresos_por_cat,
                "columna_categoria": col_cat_fin,
                # [Frente C · E3-fix] Variación vs mes anterior (saldo): si el
                # usuario filtra un mes, se compara su saldo contra el mes
                # previo del contexto calendario completo. Frontend pinta
                # "▲ vs abril" / "▼ vs abril" en la tarjeta de Saldo.
                "vs_mes_anterior": _variacion_vs_mes_anterior(
                    df_calendario, col_mes, col_m, col_t, margen_automatico,
                    mes_actual_filtro=filtro_aplicado.get("mes"),
                    col_fecha=(col_cal if es_calendario_fecha else None),
                ),
                # [B-2][A1-H1] Margen por Entidad - réplica del Excel del
                # admin. Exclusiones configurables por bloque vía
                # config.margen_entidad.exclusiones (default: ninguna).
                "margen_por_entidad": _margen_por_entidad(
                    df, col_tipo=col_tipo,
                    col_categoria=_encontrar_columna(df, "categoria"),
                    col_concepto=_encontrar_columna(df, "concepto"),
                    col_monto=col_m,
                    conceptos_genericos=_margen_exclusiones_de_config(bloque),
                ),
                # [Frente C · E4-derivados] Módulos automáticos generados desde
                # la matriz (como las tablas derivadas del Excel del admin):
                # desglose jerárquico Categoría→Concepto con Ingresos/Egresos,
                # respetando los filtros activos (mes/tipo).
                "modulos_derivados": _modulos_derivados_automaticos(
                    df,
                    col_monto=col_m,
                    col_tipo=col_tipo,
                    col_categoria=_encontrar_columna(df, "categoria"),
                    col_concepto=_encontrar_columna(df, "concepto"),
                ),
                # [P-3 · 31/08] Benchmark: promedio histórico del margen % de los
                # últimos N períodos (vs_para saber cómo vamos contra nuestro propio
                # promedio). Se calcula sobre la serie mensual ya existente.
                "benchmark_margen": _calcular_benchmark_margen(serie_m, serie_i, n_periodos=6),
                # [Fase V · E4] Punto de Equilibrio + Estructura de Costos/Gastos.
                # Derivación PURA de la matriz (una entrada → muchas salidas).
                "punto_equilibrio": _financiero.calcular_punto_equilibrio(
                    df,
                    col_monto=col_m,
                    col_tipo=col_tipo,
                    col_categoria=_encontrar_columna(df, "categoria"),
                    col_concepto=_encontrar_columna(df, "concepto"),
                    decimal_places=_decimal_places_bloque(bloque),
                ),
                # [PRIORIDAD 0 · MÉTRICAS] N° Consultas / N° Cirugías derivadas
                # de la matriz (conteo de filas por categoría). No duplica el
                # groupby de modulos_derivados — solo cuenta transacciones.
                "metricas_operativas": _mo,
                # [P-2 · 31/08] Ticket promedio total + N° operaciones (de _mo local).
                "n_operaciones": (
                    (_mo.get("n_consultas") or 0) + (_mo.get("n_cirugias") or 0)
                ),
                "ticket_promedio": (
                    round(margen_automatico["ingresos"] / n_ops, 2)
                    if (margen_automatico and margen_automatico.get("ingresos")
                        and (n_ops := (_mo.get("n_consultas") or 0) + (_mo.get("n_cirugias") or 0)))
                    else None
                ) if margen_automatico else None,
                # [PRIORIDAD 0 · LISTA DUEÑO §5] Tabla mensual del Resumen:
                # Mes × Consultas/Cirugías/Ingresos/Egresos/Margen/Margen% +
                # promedio mensual. Ensamblada desde las series calendario y
                # los conteos de _construir_series_calendario (sin reagrupar).
                "tabla_mensual": _financiero.calcular_tabla_mensual(
                    serie_i, serie_e, serie_m,
                    serie_esc.get("_conteos_mensuales"),
                    decimal_places=_decimal_places_bloque(bloque),
                ),
                # [P0B · D-1] Serie mensual de DEPRECIACIÓN derivada de la
                # matriz (egreso "Depreciación de equipos" por mes-año).
                "depreciacion_mensual": _financiero.calcular_serie_depreciacion(
                    df,
                    col_monto=col_m,
                    col_tipo=col_tipo,
                    col_cal=(col_cal if es_calendario_fecha else None),
                    col_concepto=_encontrar_columna(df, "concepto"),
                    decimal_places=_decimal_places_bloque(bloque),
                ),
                # [PRIORIDAD 0 · LISTA DUEÑO §2] Margen por Procedimiento:
                # Paciente/Procedimiento · Precio Venta · Costos Directos ·
                # Margen · Margen % — REUTILIZA _margen_por_entidad con la
                # columna Procedimiento (sin exclusiones de entidad).
                "margen_por_procedimiento": _margen_por_entidad(
                    df,
                    col_tipo=col_tipo,
                    col_categoria=_encontrar_columna(df, "categoria"),
                    col_concepto=_encontrar_columna(df, "procedimiento"),
                    col_monto=col_m,
                    conceptos_genericos=None,
                ),
            }
        except Exception:
            logger.exception("Error calculando business financiero (bloque_id=%d)", bloque_id)
            business = None

    # [Fase Q-1] Plantilla por dominio: detección DÉBIL por encabezados (regla
    # §22 — nunca fuerza, solo sugiere). Aditivo — None si no hay evidencia.
    plantilla_detectada = sugerir_plantilla(list(df.columns))

    moneda = getattr(bloque, "moneda_confirmada", None) or getattr(bloque, "moneda_detectada", None)

    return {
        "bloque_id": bloque_id,
        "tipo_bloque": tipo_bloque,
        "moneda": moneda,
        "perfil_columnas": perfil_columnas,
        "kpis": kpis,
        "serie_grafico": serie_grafico,
        "tendencia": tendencia,
        "valor_destacado": valor_destacado,
        "nombre_entidad_singular": nombre_entidad_singular,
        "anomalies": lista_anomalias,
        "margen_automatico": margen_automatico,
        "business": business,
        "filtros_aplicados": filtro_aplicado,
        "filas_ignoradas": filas_ignoradas,
        "plantilla_detectada": plantilla_detectada,
        # [Plan F · E1] Config del bloque para el frontend: colores por
        # serie/categoría, toggles de módulos, etc. Antes NUNCA se enviaba y
        # los colores personalizados no sobrevivían la recarga.
        "config": json.loads(bloque.config) if getattr(bloque, "config", None) else None,
        "narrative": narrativa,
        "eda_report": None,
        # [Fix C-1] Filtro visual de categorías: las excluidas aplicadas y el
        # catálogo completo de columna_x (para que el frontend pinte los
        # checkboxes incluso de categorías desmarcadas). Puramente informativo
        # de presentación — el recorte ya ocurrió antes de KPIs/serie.
        "categorias_excluidas": list(categorias_excluidas or []),
        "categorias_disponibles": categorias_disponibles,
        # [P0B · D-2] Activos Fijos (tabla de equipos): detección genérica por
        # columnas (no por ID). None si el bloque no es de activos fijos.
        "activos_fijos": _activos_fijos.calcular_activos_fijos(df),
        # [Fase L-1] Ejes resueltos automáticamente (null si el llamador los
        # especificó explícitamente). El frontend los usa para poblar
        # selectores sin recargar. [Ficha §2.5] El mismo dict alimenta la
        # explicación de los ejes en la narrativa.
        "ejes_auto_usados": ejes_auto_usados,
        # [R-3b] Resumen por categoría para el drawer de personalización:
        # lista de {categoria, total} ordenada descendente por total. Se usa
        # para poblar la lista de categorías visibles del drawer.
        "resumen_categorias": _calcular_resumen_categorias(df),
        # [T-1b · 31/08] Resumen de valores POR CADA columna de agrupación
        # (texto con cardinalidad ≤ 100, no identificador): alimenta los
        # acordeones del drawer ("Categorías", "Tipo", "Procedimiento"...).
        "resumen_por_columna": _calcular_resumen_por_columna(
            df, perfil_columnas, col_monto=columna_y,
        ),
    }


def obtener_serie_filtrada(
    bloque_id: int,
    columna_x: str,
    columna_y: str,
    agregacion: str = "suma",
    categorias_excluidas: list = None,
) -> dict:
    """
    Punto de entrada de los endpoints de filtro visual (Fundacional §11.1 Capa 1,
    "Filtros visuales"). El filtro es puramente de presentación: nunca modifica
    el Parquet (regla no negociable).
    """
    bloque = db.session.get(CoreBloque, bloque_id)
    if bloque is None:
        raise KeyError(f"El bloque con id={bloque_id} no existe.")

    df = _cargar_dataframe_bloque(bloque)

    resultado = generic_engine.construir_serie_grafico_filtrada(
        df, columna_x, columna_y, agregacion, categorias_excluidas,
        decimal_places=_decimal_places_bloque(bloque),
    )
    return {"bloque_id": bloque_id, **resultado}


def obtener_reporte_eda(bloque_id: int, forzar_regeneracion: bool = False) -> dict:
    """
    Genera (o reutiliza, si ya existe y `forzar_regeneracion` es False) el reporte
    de fg-data-profiling para un bloque (Fundacional §10.4), de forma asíncrona
    vía el pool compartido (eda_jobs.py). Retorna el estado del job.
    """
    bloque = db.session.get(CoreBloque, bloque_id)
    if bloque is None:
        raise KeyError(f"El bloque con id={bloque_id} no existe.")

    return obtener_reporte_eda_async(bloque, forzar_regeneracion=forzar_regeneracion)


def consultar_estado_eda(bloque_id: int):
    """Consulta el estado de un job EDA (endpoint de polling)."""
    from src.features.dashboard.eda_jobs import consultar_estado_eda as _consultar
    return _consultar(bloque_id)