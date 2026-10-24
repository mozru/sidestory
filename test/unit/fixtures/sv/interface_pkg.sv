// A package with typedefs and a struct, and an interface with modports and a clocking block.
package dma_pkg;
  typedef logic [31:0] addr_t;
  typedef struct packed {
    addr_t      addr;
    logic [7:0] len;
  } req_t;
  typedef enum logic [1:0] { RD, WR, RMW } op_e;
  localparam int MAX_LEN = 16;

  function automatic logic [7:0] clamp_len(input logic [7:0] len);
    return len > MAX_LEN ? 8'(MAX_LEN) : len;
  endfunction
endpackage : dma_pkg

interface axi_if #(parameter int W = 32) (input logic clk);
  logic         valid;
  logic         ready;
  logic [W-1:0] data;

  clocking cb @(posedge clk);
    default input #1step output #1;
    output valid, data;
    input  ready;
  endclocking

  modport mst (output valid, data, input ready, clocking cb);
  modport slv (input valid, data, output ready);
endinterface

module bus_user (
  axi_if.slv   bus,
  input logic  clk,
  output dma_pkg::req_t req_q
);
  assign bus.ready = 1'b1;
  always_ff @(posedge clk) if (bus.valid) req_q.addr <= bus.data;
endmodule
