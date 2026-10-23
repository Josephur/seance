import {expect} from "chai";
import {normalizeHost, urlHost} from "../../client/js/helpers/urlHost";

describe("urlHost", function () {
	it("lowercases and drops a trailing dot", function () {
		expect(urlHost("https://Example.ORG./a")).to.equal("example.org");
		expect(normalizeHost(" Example.ORG.. ")).to.equal("example.org");
	});

	it("returns null for something that is not a URL", function () {
		expect(urlHost("not a url")).to.equal(null);
	});
});
