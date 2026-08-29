import { Closing, Footer } from "./components/Closing";
import { Faq } from "./components/Faq";
import { FlowStrip } from "./components/FlowStrip";
import { Hero } from "./components/Hero";
import { Honesty } from "./components/Honesty";
import { Nav } from "./components/Nav";
import { ProductPreview } from "./components/ProductPreview";
import { ProofStrip } from "./components/ProofStrip";
import { Security } from "./components/Security";
import { SharingTiers } from "./components/SharingTiers";
import { Statements } from "./components/Statements";

export default function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <ProductPreview />
        <ProofStrip />
        <Statements />
        <SharingTiers />
        <FlowStrip />
        <Security />
        <Honesty />
        <Faq />
        <Closing />
      </main>
      <Footer />
    </>
  );
}
