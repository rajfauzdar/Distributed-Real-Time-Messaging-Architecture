// Thin wrapper around fetch: always returns parsed JSON, throws Error(message) on failure,
// copes with non-JSON responses (e.g. a 502 html page) and signals expired sessions.
export const AUTH_EXPIRED_EVENT = "auth:expired";

export const apiFetch = async (url, { body, method, signal, skipAuthExpiry } = {}) => {
	const res = await fetch(url, {
		method: method || (body ? "POST" : "GET"),
		headers: body ? { "Content-Type": "application/json" } : undefined,
		body: body ? JSON.stringify(body) : undefined,
		signal,
	});

	let data = null;
	try {
		data = await res.json();
	} catch {
		// non-JSON body
	}

	if (res.status === 401 && !skipAuthExpiry) {
		window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
	}

	if (!res.ok || data?.error) {
		throw new Error(data?.error || `Request failed (${res.status})`);
	}

	return data;
};
