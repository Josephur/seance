import {expect} from "chai";
import {judgeLink, linkHost} from "../../client/js/helpers/linkSafety";

describe("linkSafety (masked markdown links)", function () {
	describe("judgeLink", function () {
		it("flags a label that names another host", function () {
			expect(judgeLink("paypal.com", "https://evil.example/login")).to.deep.equal({
				kind: "mismatch",
				host: "evil.example",
				shown: "paypal.com",
			});
		});

		it("flags a label host that is only a prefix of the real one", function () {
			expect(judgeLink("https://paypal.com", "https://paypal.com.evil.io/")).to.deep.equal({
				kind: "mismatch",
				host: "paypal.com.evil.io",
				shown: "https://paypal.com",
			});
		});

		it("sees through userinfo before the host", function () {
			expect(judgeLink("bank.com", "https://bank.com@evil.example/")).to.deep.equal({
				kind: "mismatch",
				host: "evil.example",
				shown: "bank.com",
			});
		});

		it("lets a label on the same host with another path through", function () {
			expect(judgeLink("https://github.com/foo", "https://github.com/evil")).to.deep.equal({
				kind: "honest",
			});
		});

		it("ignores a www. prefix and letter case", function () {
			expect(judgeLink("www.GitHub.com", "https://github.com/x")).to.deep.equal({
				kind: "honest",
			});
		});

		it("lets a subdomain of the labelled host through", function () {
			expect(judgeLink("github.com", "https://gist.github.com/x")).to.deep.equal({
				kind: "honest",
			});
		});

		it("calls a label that is the URL honest", function () {
			expect(judgeLink("https://x.org/a", "https://x.org/a")).to.deep.equal({kind: "honest"});
		});

		it("shows the host of a prose label", function () {
			expect(judgeLink("click here", "https://example.org/p")).to.deep.equal({
				kind: "masked",
				host: "example.org",
			});
		});

		it("shows a lookalike host in punycode", function () {
			const verdict = judgeLink("click here", "https://раypal.com/");
			expect(verdict.kind).to.equal("masked");
			expect(verdict.kind === "masked" && verdict.host).to.match(/^xn--/);
		});

		it("shows the server of a web+irc link", function () {
			expect(judgeLink("#help", "web+irc://irc.evil.example/#help")).to.deep.equal({
				kind: "masked",
				host: "irc.evil.example",
			});
		});

		it("flags an address inside a longer label", function () {
			const verdict = judgeLink("see paypal.com and docs", "https://evil.example");
			expect(verdict.kind).to.equal("mismatch");
			expect(verdict.kind === "mismatch" && verdict.shown).to.equal("paypal.com");
		});

		it("treats an href it cannot parse as masked, showing it whole", function () {
			expect(judgeLink("x", "https://")).to.deep.equal({kind: "masked", host: "https://"});
		});
	});

	describe("linkHost", function () {
		it("lowercases and drops a trailing dot", function () {
			expect(linkHost("https://Example.ORG./a")).to.equal("example.org");
		});

		it("returns undefined for something that is not a URL", function () {
			expect(linkHost("not a url")).to.equal(undefined);
		});
	});
});
