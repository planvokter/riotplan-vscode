/**
 * Proxy utilities for outgoing HTTP connections.
 *
 * Resolves proxy configuration from VS Code's built-in http.proxy setting,
 * falling back to standard environment variables. Respects http.proxyStrictSSL
 * for TLS verification and NO_PROXY/no_proxy for bypass lists.
 *
 * When proxyBypass is true, returns explicit direct agents that prevent
 * VSCode/Cursor's patched Node.js HTTP stack from injecting a proxy.
 */

import * as vscode from 'vscode';
import { Agent as HttpAgent } from 'http';
import { Agent as HttpsAgent } from 'https';
import { URL } from 'url';
import { HttpsProxyAgent } from 'https-proxy-agent';

const directHttpAgent = new HttpAgent({ keepAlive: true });
const directHttpsAgent = new HttpsAgent({ keepAlive: true });

/**
 * Resolve the proxy URL to use for outgoing requests.
 * Prefers VS Code http.proxy, falls back to env vars.
 */
export function getProxyUrl(): string | undefined {
    const vscodeProxy = vscode.workspace
        .getConfiguration('http')
        .get<string>('proxy');
    if (vscodeProxy?.trim()) {
        return vscodeProxy.trim();
    }
    return (
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy ||
        undefined
    );
}

/**
 * Read VS Code's http.proxyStrictSSL setting (defaults to true).
 */
export function getStrictSSL(): boolean {
    return vscode.workspace
        .getConfiguration('http')
        .get<boolean>('proxyStrictSSL', true);
}

/**
 * Check whether a target URL should bypass the proxy based on NO_PROXY / no_proxy.
 *
 * NO_PROXY is a comma-separated list of hostnames or domain suffixes.
 * A leading dot means "any subdomain of", and "*" means bypass everything.
 */
export function isProxyBypassed(targetUrl: string): boolean {
    const noProxy = process.env.NO_PROXY || process.env.no_proxy;
    if (!noProxy) {
        return false;
    }

    let hostname: string;
    try {
        hostname = new URL(targetUrl).hostname.toLowerCase();
    } catch {
        return false;
    }

    const entries = noProxy.split(',').map((e) => e.trim().toLowerCase());
    for (const entry of entries) {
        if (!entry) {
            continue;
        }
        if (entry === '*') {
            return true;
        }
        if (hostname === entry) {
            return true;
        }
        const suffix = entry.startsWith('.') ? entry : `.${entry}`;
        if (hostname.endsWith(suffix)) {
            return true;
        }
    }
    return false;
}

/**
 * Return an agent for the given target URL.
 *
 * When `bypass` is true, returns an explicit direct agent (http or https)
 * that overrides any proxy injected by VSCode/Cursor's Node.js patching.
 *
 * Otherwise returns an HttpsProxyAgent when a proxy is configured, or
 * undefined to use the default behaviour.
 */
export function getProxyAgent(
    targetUrl: string,
    bypass?: boolean
): HttpAgent | HttpsAgent | HttpsProxyAgent<string> | undefined {
    if (bypass) {
        try {
            const isHttps = new URL(targetUrl).protocol === 'https:';
            return isHttps ? directHttpsAgent : directHttpAgent;
        } catch {
            return directHttpAgent;
        }
    }

    const proxyUrl = getProxyUrl();
    if (!proxyUrl) {
        return undefined;
    }
    if (isProxyBypassed(targetUrl)) {
        return undefined;
    }
    return new HttpsProxyAgent(proxyUrl, {
        rejectUnauthorized: getStrictSSL(),
    });
}
