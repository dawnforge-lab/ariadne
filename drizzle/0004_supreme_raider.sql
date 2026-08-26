CREATE INDEX "pages_simhash_band0" ON "pages" USING btree ("crawl_id",(("simhash" >> 0) & 65535));--> statement-breakpoint
CREATE INDEX "pages_simhash_band1" ON "pages" USING btree ("crawl_id",(("simhash" >> 16) & 65535));--> statement-breakpoint
CREATE INDEX "pages_simhash_band2" ON "pages" USING btree ("crawl_id",(("simhash" >> 32) & 65535));--> statement-breakpoint
CREATE INDEX "pages_simhash_band3" ON "pages" USING btree ("crawl_id",(("simhash" >> 48) & 65535));