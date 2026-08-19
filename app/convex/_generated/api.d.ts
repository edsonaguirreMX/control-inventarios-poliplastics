/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ajustesInventario from "../ajustesInventario.js";
import type * as alertas from "../alertas.js";
import type * as auth from "../auth.js";
import type * as authActions from "../authActions.js";
import type * as cierreEngine from "../cierreEngine.js";
import type * as cierres from "../cierres.js";
import type * as correcciones from "../correcciones.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as entradas from "../entradas.js";
import type * as importacionInicial from "../importacionInicial.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_fechaOperativa from "../lib/fechaOperativa.js";
import type * as lib_paginas from "../lib/paginas.js";
import type * as lib_puntoReorden from "../lib/puntoReorden.js";
import type * as lib_vistasPanel from "../lib/vistasPanel.js";
import type * as materiales from "../materiales.js";
import type * as notificaciones from "../notificaciones.js";
import type * as parametros from "../parametros.js";
import type * as peps from "../peps.js";
import type * as reporteDiario from "../reporteDiario.js";
import type * as roles from "../roles.js";
import type * as seed from "../seed.js";
import type * as seedData from "../seedData.js";
import type * as testHelpers from "../testHelpers.js";
import type * as tiempo from "../tiempo.js";
import type * as usuarios from "../usuarios.js";
import type * as usuariosActions from "../usuariosActions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ajustesInventario: typeof ajustesInventario;
  alertas: typeof alertas;
  auth: typeof auth;
  authActions: typeof authActions;
  cierreEngine: typeof cierreEngine;
  cierres: typeof cierres;
  correcciones: typeof correcciones;
  crons: typeof crons;
  dashboard: typeof dashboard;
  entradas: typeof entradas;
  importacionInicial: typeof importacionInicial;
  "lib/auth": typeof lib_auth;
  "lib/fechaOperativa": typeof lib_fechaOperativa;
  "lib/paginas": typeof lib_paginas;
  "lib/puntoReorden": typeof lib_puntoReorden;
  "lib/vistasPanel": typeof lib_vistasPanel;
  materiales: typeof materiales;
  notificaciones: typeof notificaciones;
  parametros: typeof parametros;
  peps: typeof peps;
  reporteDiario: typeof reporteDiario;
  roles: typeof roles;
  seed: typeof seed;
  seedData: typeof seedData;
  testHelpers: typeof testHelpers;
  tiempo: typeof tiempo;
  usuarios: typeof usuarios;
  usuariosActions: typeof usuariosActions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
