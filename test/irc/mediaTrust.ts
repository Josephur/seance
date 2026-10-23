import {expect} from "chai";
import {
	accountKey,
	channelKey,
	clearTrusted,
	isPreviewRevealed,
	isTrusted,
	isTrustedHost,
	mediaFileName,
	mediaHost,
	splitKey,
	STORAGE_KEY,
	trust,
	trustedMedia,
	trustedMediaHosts,
	trustedScopesOf,
	trustHost,
	untrust,
	untrustHost,
	useStorageBackend,
} from "../../client/js/helpers/mediaTrust";
import {mediaScopesOf, mediaTrustMenu} from "../../client/js/helpers/mediaTrustMenu";

function fakeStorage() {
	const data = new Map<string, string>();

	return {
		data,
		get: (key: string) => data.get(key) ?? null,
		set(key: string, value: string) {
			data.set(key, value);
		},
		remove(key: string) {
			data.delete(key);
		},
	};
}

const stored = (storage: ReturnType<typeof fakeStorage>) =>
	JSON.parse(storage.data.get(STORAGE_KEY) ?? "null") as unknown;

describe("helpers/mediaTrust", function () {
	let storage: ReturnType<typeof fakeStorage>;

	beforeEach(function () {
		storage = fakeStorage();
		useStorageBackend(storage);
	});

	afterEach(function () {
		useStorageBackend(null);
	});

	describe("mediaHost / mediaFileName / keys", function () {
		it("extracts a lower-cased host without the port", function () {
			expect(mediaHost("https://I.Imgur.COM:8443/abc.png")).to.equal("i.imgur.com");
			expect(mediaHost("https://example.com./a.png")).to.equal("example.com");
		});

		it("returns null for unparsable links", function () {
			expect(mediaHost("not a url")).to.equal(null);
			expect(mediaHost("")).to.equal(null);
		});

		it("names the file, decoded, ignoring query and fragment", function () {
			expect(mediaFileName("https://x.test/dir/My%20cat.png?w=1#f")).to.equal("My cat.png");
			expect(mediaFileName("https://x.test/")).to.equal("");
			expect(mediaFileName("nope")).to.equal("");
		});

		it("builds case-insensitive channel and account keys and splits them again", function () {
			expect(channelKey("uuid-1", "#Pics")).to.equal("uuid-1/#pics");
			expect(accountKey("uuid-1", "Alice")).to.equal("uuid-1/alice");
			expect(splitKey("uuid-1/#pics")).to.deep.equal({network: "uuid-1", name: "#pics"});
			expect(splitKey("#odd/name")).to.deep.equal({network: "#odd", name: "name"});
			expect(splitKey("bare")).to.deep.equal({network: "", name: "bare"});
		});
	});

	describe("trusted hosts", function () {
		it("starts empty and persists additions under the thelounge key", function () {
			expect(trustedMediaHosts()).to.deep.equal([]);
			trustHost("I.Imgur.com");
			expect(isTrustedHost("i.imgur.com")).to.equal(true);
			expect(isTrustedHost("I.IMGUR.COM")).to.equal(true);
			expect(stored(storage)).to.deep.equal({
				host: ["i.imgur.com"],
				channel: [],
				account: [],
			});
		});

		it("does not add duplicates, empty hosts or nulls", function () {
			trustHost("a.test");
			trustHost("A.TEST");
			trustHost("   ");
			expect(trustedMediaHosts()).to.deep.equal(["a.test"]);
			expect(isTrustedHost(null)).to.equal(false);
			expect(isTrustedHost(undefined)).to.equal(false);
		});

		it("removes and clears, writing storage each time", function () {
			trustHost("a.test");
			trustHost("b.test");
			untrustHost("A.test");
			expect(trustedMediaHosts()).to.deep.equal(["b.test"]);
			expect((stored(storage) as {host: string[]}).host).to.deep.equal(["b.test"]);

			untrustHost("never.added");
			expect(trustedMediaHosts()).to.deep.equal(["b.test"]);

			clearTrusted("host");
			expect(trustedMediaHosts()).to.deep.equal([]);
			expect((stored(storage) as {host: string[]}).host).to.deep.equal([]);
		});

		it("keeps the same array instance so reactive readers see changes", function () {
			const list = trustedMediaHosts();
			trustHost("a.test");
			expect(list).to.deep.equal(["a.test"]);
		});

		it("reads the first, bare-array format as hosts", function () {
			storage.set(STORAGE_KEY, JSON.stringify(["Cdn.Example", 42, "", null]));
			useStorageBackend(storage);
			expect(trustedMediaHosts()).to.deep.equal(["cdn.example"]);
			expect(trustedMedia("channel")).to.deep.equal([]);
		});

		it("survives corrupt storage by discarding it", function () {
			storage.set(STORAGE_KEY, "{not json");
			useStorageBackend(storage);
			expect(trustedMediaHosts()).to.deep.equal([]);
			expect(storage.data.has(STORAGE_KEY)).to.equal(false);
		});
	});

	describe("trusted channels and accounts", function () {
		it("keeps the three kinds apart and persists them together", function () {
			trust("channel", channelKey("net", "#Pics"));
			trust("account", accountKey("net", "Alice"));
			trust("host", "cdn.example");

			expect(isTrusted("channel", "net/#pics")).to.equal(true);
			expect(isTrusted("account", "net/alice")).to.equal(true);
			expect(isTrusted("account", "net/#pics")).to.equal(false);
			expect(isTrusted("channel", "other/#pics")).to.equal(false);
			expect(stored(storage)).to.deep.equal({
				host: ["cdn.example"],
				channel: ["net/#pics"],
				account: ["net/alice"],
			});
		});

		it("loads the object format and drops junk", function () {
			storage.set(
				STORAGE_KEY,
				JSON.stringify({host: ["A.b"], channel: ["net/#c", 1], account: null, extra: 1})
			);
			useStorageBackend(storage);
			expect(trustedMedia("host")).to.deep.equal(["a.b"]);
			expect(trustedMedia("channel")).to.deep.equal(["net/#c"]);
			expect(trustedMedia("account")).to.deep.equal([]);
		});

		it("clears everything at once", function () {
			trust("host", "a.b");
			trust("channel", "net/#c");
			trust("account", "net/x");
			clearTrusted();
			expect(stored(storage)).to.deep.equal({host: [], channel: [], account: []});
			untrust("channel", "net/#c"); // no-op, must not throw
		});
	});

	describe("isPreviewRevealed", function () {
		const link = "https://cdn.example/pic.png";
		const scope = {
			channel: channelKey("net", "#pics"),
			channelName: "#pics",
			account: accountKey("net", "alice"),
			accountName: "alice",
		};

		it("follows the policy when the reader has not chosen", function () {
			expect(isPreviewRevealed({link}, false)).to.equal(false);
			expect(isPreviewRevealed({link}, true)).to.equal(true);
			trustHost("cdn.example");
			expect(isPreviewRevealed({link}, false)).to.equal(true);
		});

		it("reveals through the channel or the sender's account", function () {
			expect(isPreviewRevealed({link, scope}, false)).to.equal(false);
			trust("channel", scope.channel);
			expect(isPreviewRevealed({link, scope}, false)).to.equal(true);
			expect(trustedScopesOf({link, scope})).to.deep.equal(["channel"]);

			untrust("channel", scope.channel);
			trust("account", scope.account);
			expect(isPreviewRevealed({link, scope}, false)).to.equal(true);
			expect(trustedScopesOf({link, scope})).to.deep.equal(["account"]);

			// Same account on another network is a different key.
			expect(
				isPreviewRevealed(
					{link, scope: {...scope, account: accountKey("other", "alice")}},
					false
				)
			).to.equal(false);
		});

		it("lets the reader's explicit choice win over the policy", function () {
			expect(isPreviewRevealed({link, revealed: true}, false)).to.equal(true);
			trustHost("cdn.example");
			expect(isPreviewRevealed({link, revealed: false}, true)).to.equal(false);
		});

		it("does not reveal a preview with an unparsable link", function () {
			expect(isPreviewRevealed({link: "nope"}, false)).to.equal(false);
		});
	});

	describe("mediaTrustMenu", function () {
		const link = "https://cdn.example/pic.png";
		const preview = {
			link,
			scope: {
				channel: channelKey("net", "#pics"),
				channelName: "#pics",
				account: accountKey("net", "alice"),
				accountName: "alice",
			},
		};

		it("lists host, account and channel scopes with labels", function () {
			expect(mediaScopesOf(preview).map((s) => s.label)).to.deep.equal([
				"from cdn.example",
				"from alice",
				"in #pics",
			]);
			// Not logged in, posted in a query: only the host is offered.
			expect(mediaScopesOf({link}).map((s) => s.kind)).to.deep.equal(["host"]);
		});

		it("offers 'always show' for untrusted scopes and 'stop' for trusted ones", function () {
			const changes: string[] = [];
			const onChange = (kind: string, trusted: boolean) => changes.push(`${kind}:${trusted}`);

			let items = mediaTrustMenu(preview, onChange);
			expect(items.map((i) => ("label" in i ? i.label : "|"))).to.deep.equal([
				"Always show from cdn.example",
				"Always show from alice",
				"Always show in #pics",
			]);

			("action" in items[1] ? items[1] : {action() {}}).action();
			expect(isTrusted("account", "net/alice")).to.equal(true);
			expect(changes).to.deep.equal(["account:true"]);

			items = mediaTrustMenu(preview, onChange);
			expect(items.map((i) => ("label" in i ? i.label : "|"))).to.deep.equal([
				"Always show from cdn.example",
				"Always show in #pics",
				"|",
				"Stop always showing from alice",
			]);
			expect(items[3]).to.include({class: "media-account-off"});

			("action" in items[3] ? items[3] : {action() {}}).action();
			expect(isTrusted("account", "net/alice")).to.equal(false);
			expect(changes).to.deep.equal(["account:true", "account:false"]);
		});
	});
});
