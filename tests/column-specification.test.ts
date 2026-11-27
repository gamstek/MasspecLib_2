import {test} from 'node:test';import assert from 'node:assert/strict';import{columnDimensionValue,columnFilmThickness,columnParticleSize}from'../src/shared/scientificDisplay.ts';
test('screenshot main column is distinct from precolumn and input is unchanged',()=>{const m={column_type:'Kinetex C18 EVO 2.6 um, 2.1x50 mm, precolumn 2.1x5 mm, Phenomenex'},before=JSON.stringify(m);assert.equal(columnDimensionValue(m,'column_length_mm'),50);assert.equal(columnDimensionValue(m,'column_inner_diameter_mm'),2.1);assert.equal(columnParticleSize(m),2.6);assert.equal(JSON.stringify(m),before)});
test('structured values win, reversed specifications work and ambiguous or unitless text stays unresolved',()=>{const m={column_type:'C18 50 mm × 2.1 mm, 2.6 μm; guard column 2.1x5 mm, 5 μm',column_length_mm:100};assert.equal(columnDimensionValue(m,'column_length_mm'),100);assert.equal(columnDimensionValue(m,'column_inner_diameter_mm'),2.1);assert.equal(columnParticleSize(m),2.6);for(const text of ['C18 2.1x50','C18 2.1x50 mm and C8 4.6x150 mm','precolumn 2.1x50 mm','C18 2x3 mm'])assert.equal(columnDimensionValue({column_type:text},'column_length_mm'),null)});

test('LDS BEH C18 dimensions and explicit gas-column film thickness stay distinct', () => {
  const lc = { column_type: 'BEH C18 1.7um, 2.1x100mm, Waters' }
  assert.equal(columnDimensionValue(lc, 'column_length_mm'), 100)
  assert.equal(columnDimensionValue(lc, 'column_inner_diameter_mm'), 2.1)
  assert.equal(columnParticleSize(lc), 1.7)
  const gc = { column_type: 'Rxi-5Sil MS column, 30m, 0.25mm i.d., 0.25µm film thickness, Restek' }
  assert.equal(columnDimensionValue(gc, 'column_length_mm'), 30_000)
  assert.equal(columnDimensionValue(gc, 'column_inner_diameter_mm'), 0.25)
  assert.equal(columnParticleSize(gc), null)
  assert.equal(columnFilmThickness(gc), 0.25)
})
