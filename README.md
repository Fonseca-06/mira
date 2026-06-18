# Mira — Inteligência Comercial e de Preços

SPA de inteligência comercial para análise e comparação de preços de pneus (cliente Uendel).
HTML/CSS/JS puro + Supabase (Postgres) + Chart.js.

## Funcionalidades
- **Comparativo** — preço nosso vs concorrente por medida + UF, com detalhe preço a preço.
- **Cruzamento** — simula seus preços (manual ou CSV) contra a base de concorrentes.
- **Preços / Cadastro / Catálogo** — CRUD da base.
- **Histórico** — evolução de preço por medida (gráfico).
- **Formação de Preço** — cálculo fiscal (ICMS-ST, DIFAL, markup).
- Tema claro/escuro.

## Rodar localmente
```bash
python3 server.py   # serve em http://localhost:8000 com cache desabilitado
```

## Importar dados (script único)
A chave `service_role` é lida do ambiente — **nunca** versionar:
```bash
SUPABASE_SERVICE_KEY="sua_chave" python3 importar_dados.py
```

## Configuração
A chave `anon` pública fica em `app.js` (protegida por RLS no Supabase).
